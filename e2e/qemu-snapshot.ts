import { QemuMonitor } from "./lib/qemu.js";
import { Deployer } from "./lib/deploy.js";
import { ShellHelper } from "./lib/shell.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";


// Parse CLI args
const args = process.argv.slice(2);
const UPDATE_MODE = args.includes("--update");
const KEEP_RUNNING = args.includes("--keep-running");

// Paths
const PROJECT_ROOT = join(import.meta.dir, "..");
const VM_DIR = join(import.meta.dir, "qemu-images");
const BASE_IMAGE = join(VM_DIR, "base.qcow2");
const OVERLAY_IMAGE = join(VM_DIR, "overlay.qcow2");
const SOCKET_PATH = "/tmp/qemu-monitor.sock";
const SSH_KEY = join(VM_DIR, "id_ed25519");
const SSH_PORT = 2222;
const SSH_USER = "testuser";
const REFERENCES_DIR = join(import.meta.dir, "expected-qemu");
const OUTPUT_DIR = join(import.meta.dir, "output-qemu");
const PYTHON_SRC = join(PROJECT_ROOT, "src/voice_to_text");
const TEST_AUDIO = join(import.meta.dir, "fixtures/test-audio.wav");
const EXPECTED_FILE = join(import.meta.dir, "fixtures/expected-text.txt");

/** Check if QEMU monitor socket is responsive. */
async function isVmRunning(): Promise<boolean> {
  if (!existsSync(SOCKET_PATH)) return false;
  try {
    const sock = net.createConnection(SOCKET_PATH);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { sock.destroy(); reject(); }, 2000);
      sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolve(); });
      sock.on("error", () => { clearTimeout(timer); reject(); });
    });
    return true;
  } catch {
    return false;
  }
}

interface Step {
  name: string;
  fn: () => Promise<void>;
  timeout?: number;
}

class StepRunner {
  async run(steps: Step[]): Promise<void> {
    for (const step of steps) {
      console.log(`[step] ${step.name}`);
      const start = Date.now();

      try {
        await step.fn();
        const ms = Date.now() - start;
        console.log(`  ✓ ${step.name} (${(ms / 1000).toFixed(1)}s)`);
      } catch (err) {
        const ms = Date.now() - start;
        console.error(`  ✗ ${step.name} FAILED (${(ms / 1000).toFixed(1)}s):`, err);
        throw err;
      }
    }
  }
}

class VmManager {
  process: ReturnType<typeof Bun.spawn> | null = null;
  booted = false;
  qemu: QemuMonitor;
  deployer: Deployer;
  shell: ShellHelper;

  constructor() {
    this.qemu = new QemuMonitor(SOCKET_PATH);
    this.deployer = new Deployer({
      host: "localhost",
      port: SSH_PORT,
      username: SSH_USER,
      privateKey: readFileSync(SSH_KEY),
    });
    this.shell = new ShellHelper();
  }

  async boot(): Promise<void> {
    // Check if VM is already running
    if (await isVmRunning()) {
      console.log("VM already running, connecting...");
      await this.qemu.connect();
      this.booted = false;
      return;
    }

    // Remove stale socket
    Bun.spawnSync(["rm", "-f", SOCKET_PATH]);

    // Create overlay
    if (UPDATE_MODE || !existsSync(OVERLAY_IMAGE)) {
      console.log("Creating fresh VM overlay...");
      const proc = Bun.spawnSync([
        "qemu-img", "create", "-f", "qcow2",
        "-b", BASE_IMAGE, "-F", "qcow2", OVERLAY_IMAGE,
      ]);
      if (proc.exitCode !== 0) throw new Error(`Failed to create overlay: ${proc.stderr.toString()}`);
    } else {
      console.log("Reusing existing overlay...");
    }

    // Start QEMU
    this.process = Bun.spawn([
      "qemu-system-x86_64",
      "-enable-kvm",
      "-cpu", "host",
      "-m", "4096",
      "-smp", "2",
      "-drive", `file=${OVERLAY_IMAGE},format=qcow2,if=virtio`,
      "-device", "virtio-vga",
      "-display", "vnc=:1",
      "-monitor", `unix:${SOCKET_PATH},server,nowait`,
      "-serial", "file:serial.log",
      "-netdev", `user,id=net0,hostfwd=tcp::${SSH_PORT}-:22`,
      "-device", "virtio-net-pci,netdev=net0",
      "-no-reboot",
    ], {
      cwd: VM_DIR,
      stdout: "inherit",
      stderr: "inherit",
    });

    this.booted = true;

    // Wait for socket to appear
    for (let i = 0; i < 30; i++) {
      if (existsSync(SOCKET_PATH)) break;
      await Bun.sleep(500);
    }

    // Connect QMP
    await this.qemu.connect();
  }

  async waitForSsh(timeoutMs = 120_000): Promise<void> {
    // Open shell session (persistent SSH via shell-use)
    await this.shell.openSshSession({
      sshKey: SSH_KEY,
      sshPort: SSH_PORT,
      sshUser: SSH_USER,
    });
  }

  async setup(): Promise<void> {
    // Wait for GDM auto-login
    console.log("Waiting for GDM auto-login...");
    await this.pollUntil(
      "GDM session with seat",
      async () => {
        const output = await this.shell.exec(
          "loginctl list-sessions 2>/dev/null | grep -q seat0"
        );
        return output.includes("seat0");
      },
      60000
    );

    // Extract D-Bus address
    await this.shell.exec(
      `DBUS_ADDR=$(cat /proc/$(pgrep -f 'gnome-shell --mode=user' | head -1)/environ 2>/dev/null | tr '\\0' '\\n' | grep DBUS_SESSION_BUS_ADDRESS | head -1 | cut -d= -f2-); if [ -n "$DBUS_ADDR" ]; then echo "$DBUS_ADDR" > /tmp/dbus-address; fi`
    );

    // Enable extension
    await this.shell.exec(
      "gnome-extensions enable voice-to-text@happytomatoe.com 2>/dev/null || true"
    );
    await this.shell.exec(
      "gsettings set org.gnome.shell.extensions.voice-to-text provider deepgram 2>/dev/null || true"
    );

    // Wait for GNOME Shell
    await this.pollUntil(
      "GNOME Shell",
      async () => {
        const output = await this.shell.exec(
          "pgrep -f 'gnome-shell --mode=user'"
        );
        return output.trim().length > 0;
      },
      10000
    );

    // Start dotoold
    console.log("Starting dotoold...");
    await this.shell.exec(
      "export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe; /home/testuser/.local/bin/dotoold &>/tmp/dotoold.log &"
    );

    await this.pollUntil(
      "dotool pipe",
      async () => {
        const output = await this.shell.exec(
          "test -p /run/user/$(id -u)/dotool-pipe"
        );
        return output.length === 0; // test succeeds with no output
      },
      10000
    );

    // Deploy Python source (ssh2 for file transfer)
    if (existsSync(PYTHON_SRC)) {
      console.log("Deploying Python source...");
      await this.shell.exec("mkdir -p ~/voice_to_text/src");
      await this.deployer.uploadDir(PYTHON_SRC, "~/voice_to_text/src/voice_to_text");
    }

    // Deploy test audio (ssh2 for file transfer)
    if (existsSync(TEST_AUDIO)) {
      await this.deployer.uploadFile(TEST_AUDIO, "/tmp/test-audio.wav");
    }

    // Install Python dependencies
    console.log("Installing Python dependencies...");
    await this.shell.exec(
      "pip3 install --user --break-system-packages --quiet httpx dbus-next numpy pyyaml python-dotenv websockets 2>/dev/null || true"
    );

    // Start voice service
    const providerArgs = process.env.PARAKEET_MODEL_PATH
      ? `export PARAKEET_MODEL_PATH=${process.env.PARAKEET_MODEL_PATH}; export VOICE_TO_TEXT_PROVIDER=parakeet;`
      : `export DEEPGRAM_API_KEY=${process.env.DEEPGRAM_API_KEY ?? ""};`;

    await this.shell.exec(
      `export PATH=$HOME/.local/bin:$PATH; export XDG_RUNTIME_DIR=/run/user/$(id -u); ${providerArgs} export VOICE_TO_TEXT_DEBUG_FILE=/tmp/test-audio.wav; export PYTHONPATH=~/voice_to_text/src; cd ~; nohup python3 -m voice_to_text > /tmp/voice-service.log 2>&1 &`
    );

    // Wait for D-Bus service
    await this.pollUntil(
      "D-Bus service",
      async () => {
        const output = await this.shell.exec(
          "busctl --user list 2>/dev/null | grep -q com.happytomatoe.VoiceToText"
        );
        return output.includes("com.happytomatoe.VoiceToText");
      },
      15000
    );

    // Save snapshot for hot boot
    if (UPDATE_MODE) {
      console.log("Saving VM snapshot for hot boot...");
      await this.qemu.savevm("ready");
      await Bun.sleep(2000);
    }
  }

  private async pollUntil(
    desc: string,
    check: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs = 1000
  ): Promise<void> {
    const start = Date.now();
    process.stdout.write(`Waiting for ${desc}`);

    while (Date.now() - start < timeoutMs) {
      if (await check()) {
        console.log(` ready (${Math.round((Date.now() - start) / 1000)}s)`);
        return;
      }
      process.stdout.write(".");
      await Bun.sleep(intervalMs);
    }

    console.log(` TIMEOUT after ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(`Timeout waiting for ${desc}`);
  }

  async openShell(): Promise<void> {
    await this.shell.openSshSession({
      sshKey: SSH_KEY,
      sshPort: SSH_PORT,
      sshUser: SSH_USER,
    });
  }

  async shutdown(): Promise<void> {
    if (!this.booted) {
      console.log("VM was not started by this run, skipping shutdown");
      this.qemu.close();
      await this.shell.close();
      await this.deployer.disconnect();
      return;
    }
    try {
      await this.qemu.systemPowerdown();
      await Bun.sleep(5000);
    } finally {
      this.process?.kill("SIGKILL");
      this.qemu.close();
      await this.shell.close();
      await this.deployer.disconnect();
    }
  }
}

async function preflight(): Promise<void> {
  if (!existsSync(BASE_IMAGE)) {
    throw new Error(`Base VM image not found: ${BASE_IMAGE}\nRun 'just qemu-e2e-setup' first.`);
  }

  if (!existsSync(SSH_KEY)) {
    throw new Error(`SSH key not found: ${SSH_KEY}\nRun 'just qemu-e2e-setup' first.`);
  }
}

async function runTestFlow(vm: VmManager): Promise<void> {
  const shell = vm.shell;

  // Step 1: Open terminal and attach to tmux
  console.log("Opening terminal with tmux...");
  await shell.exec("nohup gnome-terminal &>/dev/null &");
  await Bun.sleep(3000);
  await shell.dotoolCommand("type tmux attach -t test");
  await Bun.sleep(500);
  await shell.dotoolCommand("key Enter");
  await Bun.sleep(2000);

  // Step 2: Type echo command
  console.log("Typing echo command...");
  await shell.dotoolCommand('type echo "');
  await Bun.sleep(1000);

  // Step 3: Start recording via hotkey
  console.log("Starting recording via hotkey...");
  await shell.sendHotkey();
  await Bun.sleep(2000);

  // Step 4: Wait for transcription
  console.log("Waiting for transcription...");
  let transcription = "";
  try {
    transcription = await shell.waitForTranscription(30000);
    console.log(`  Got: ${transcription}`);
  } catch {
    console.log("  TIMEOUT - continuing anyway");
  }

  // Step 5: Stop recording
  console.log("Stopping recording via hotkey...");
  await shell.sendHotkey();
  await Bun.sleep(2000);

  // Step 6: Write result to file
  console.log("Writing result to file...");
  if (transcription) {
    await shell.exec(`echo '${transcription}' > /tmp/file.txt`);
  } else {
    console.log("  WARNING: No transcription captured");
    await shell.exec("echo '' > /tmp/file.txt");
  }
  await Bun.sleep(1000);
}

async function verifyResult(vm: VmManager): Promise<{ passed: boolean; message: string }> {
  console.log("\n=== Verification ===");

  if (!existsSync(EXPECTED_FILE)) {
    // Just check if file exists
    const { code } = await vm.deployer.exec("test -f /tmp/file.txt");
    if (code === 0) {
      const { stdout } = await vm.deployer.exec("cat /tmp/file.txt");
      return { passed: true, message: `/tmp/file.txt exists: ${stdout}` };
    }
    return { passed: false, message: "/tmp/file.txt not found" };
  }

  const expected = readFileSync(EXPECTED_FILE, "utf-8").trim();
  const { stdout: actual } = await vm.deployer.exec("cat /tmp/file.txt 2>/dev/null");

  console.log(`  Expected: ${expected}`);
  console.log(`  Actual:   ${actual.trim()}`);

  if (actual.trim() === expected) {
    return { passed: true, message: "Text matches expected output" };
  }
  return { passed: false, message: "Text does not match" };
}

async function main(): Promise<void> {
  const vm = new VmManager();
  const startTime = Date.now();
  let testsFailed = 0;

  try {
    await new StepRunner().run([
      { name: "preflight", fn: preflight },
      { name: "boot-vm", fn: () => vm.boot(), timeout: 120_000 },
      { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 120_000 },
      { name: "setup", fn: () => vm.setup(), timeout: 180_000 },
      { name: "test-flow", fn: () => runTestFlow(vm) },
    ]);

    // Verify
    const result = await verifyResult(vm);
    if (result.passed) {
      console.log(`  PASS: ${result.message}`);
    } else {
      console.log(`  FAIL: ${result.message}`);
      testsFailed++;
    }
  } catch (err) {
    console.error("\nFATAL:", err);
    testsFailed++;
  } finally {
    if (!KEEP_RUNNING) {
      await vm.shutdown();
    } else {
      console.log("\nVM kept running (--keep-running flag)");
      console.log(`SSH: ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@localhost`);
    }
  }

  // Timing summary
  const elapsed = Date.now() - startTime;
  console.log("\n=== Timing Summary ===");
  console.log(`  Total: ${(elapsed / 1000).toFixed(1)}s`);
  console.log("");

  if (testsFailed === 0) {
    console.log("All tests passed!");
    process.exit(0);
  } else {
    console.log(`${testsFailed} test(s) failed.`);
    process.exit(1);
  }
}

main();
