import { QemuMonitor } from "./lib/qemu.js";
import { Deployer } from "./lib/deploy.js";
import { ShellHelper } from "./lib/shell.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { execSync } from "node:child_process";


// Parse CLI args
const args = process.argv.slice(2);
const UPDATE_MODE = args.includes("--update");
const KEEP_RUNNING = args.includes("--keep-running");
const NO_RECORD = args.includes("--no-record");
const RECORD_MODE = !NO_RECORD; // enabled by default
const TIMING_MODE = args.includes("--timing");

function timing(label: string, startMs: number): void {
  if (TIMING_MODE) {
    const ms = Date.now() - startMs;
    console.log(`  [time] ${label}: ${ms}ms`);
  }
}

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
const OUTPUT_DIR = join(import.meta.dir, "output");
const PYTHON_SRC = join(PROJECT_ROOT, "src/voice_to_text");
const TEST_AUDIO = join(import.meta.dir, "fixtures/test-audio.wav");
const EXPECTED_FILE = join(import.meta.dir, "fixtures/expected-text.txt");
const RECORDING_DIR = join(import.meta.dir, "output", "recording");
const PARAKEET_PORT = 5092;
const PARAKEET_SCRIPT = join(PROJECT_ROOT, "parakeet-v2.sh");

/** Check if Parakeet server is running on the host. */
async function ensureParakeet(): Promise<void> {
  // Check if port 5092 is listening
  try {
    const sock = net.createConnection(PARAKEET_PORT, "localhost");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { sock.destroy(); reject(); }, 2000);
      sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolve(); });
      sock.on("error", () => { clearTimeout(timer); reject(); });
    });
    console.log("  Parakeet already running on port " + PARAKEET_PORT);
    return;
  } catch {
    // Not running
  }

  // Try to start Parakeet
  if (existsSync(PARAKEET_SCRIPT)) {
    console.log("  Starting Parakeet server...");
    try {
      execSync(`bash ${PARAKEET_SCRIPT}`, { stdio: "inherit", timeout: 120_000 });
      console.log("  Parakeet started");
    } catch (err) {
      console.log("  WARNING: Failed to start Parakeet:", err);
      console.log("  Transcription will use cloud provider (Deepgram) if available");
    }
  } else {
    console.log("  WARNING: Parakeet script not found at " + PARAKEET_SCRIPT);
    console.log("  Transcription will use cloud provider (Deepgram) if available");
  }
}

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
  frameCount = 0;

  constructor() {
    this.qemu = new QemuMonitor(SOCKET_PATH);
    this.deployer = new Deployer({
      host: "localhost",
      port: SSH_PORT,
      username: SSH_USER,
      privateKey: readFileSync(SSH_KEY),
    });
    this.shell = new ShellHelper();
    if (RECORD_MODE) {
      mkdirSync(RECORDING_DIR, { recursive: true });
    }
  }

  async captureFrame(label: string): Promise<void> {
    if (!RECORD_MODE) return;
    const path = join(RECORDING_DIR, `frame-${String(this.frameCount++).padStart(4, "0")}-${label}.ppm`);
    try {
      await this.qemu.screendump(path);
      console.log(`  [rec] ${label}`);
    } catch {
      // Ignore screendump errors
    }
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
      "-display", "none",
      "-spice", "port=5930,disable-ticketing=on",
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
          "loginctl list-sessions"
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

    // Deploy GNOME extension
    const extDir = join(PROJECT_ROOT, "gnome-ext");
    const extUuid = "voice-to-text@happytomatoe.com";
    if (existsSync(extDir)) {
      console.log("Deploying GNOME extension...");
      await this.shell.exec(`mkdir -p ~/.local/share/gnome-shell/extensions/${extUuid}`);
      execSync(
        `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${SSH_KEY} -P ${SSH_PORT} -r ${extDir}/* ${SSH_USER}@localhost:~/.local/share/gnome-shell/extensions/${extUuid}/`,
        { stdio: "inherit" }
      );
      // Compile schemas and enable extension
      await this.shell.exec(`glib-compile-schemas ~/.local/share/gnome-shell/extensions/${extUuid}/schemas/ 2>/dev/null || true`);
      await this.shell.exec(`dconf write /org/gnome/shell/enabled-extensions "['${extUuid}']"`);
      await this.shell.exec(`gsettings set org.gnome.shell.extensions.voice-to-text provider deepgram 2>/dev/null || true`);
    }
    // Deploy Python source (scp from host side)
    if (existsSync(PYTHON_SRC)) {
      console.log("Deploying Python source...");
      await this.shell.exec("mkdir -p ~/voice_to_text/src/voice_to_text");
      execSync(
        `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${SSH_KEY} -P ${SSH_PORT} -r ${PYTHON_SRC}/* ${SSH_USER}@localhost:~/voice_to_text/src/voice_to_text/`,
        { stdio: "inherit" }
      );
    }

    // Deploy test audio (scp from host side)
    if (existsSync(TEST_AUDIO)) {
      execSync(
        `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${SSH_KEY} -P ${SSH_PORT} ${TEST_AUDIO} ${SSH_USER}@localhost:/tmp/test-audio.wav`,
        { stdio: "inherit" }
      );
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
          "busctl --user list 2>/dev/null | grep com.happytomatoe.VoiceToText"
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

  async pollUntil(
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

  // Ensure Parakeet is available for local transcription
  await ensureParakeet();
}

async function runTestFlow(vm: VmManager): Promise<void> {
  const shell = vm.shell;
  let t: number;

  t = Date.now();
  await vm.captureFrame("01-desktop");
  timing("capture-frame", t);

  // Step 1: Dismiss Activities overview if open
  t = Date.now();
  console.log("Dismissing Activities...");
  await shell.dotoolCommand("key Escape");
  await Bun.sleep(1000);
  timing("dismiss-activities", t);

  // Step 2: Open terminal and wait for it to be ready
  t = Date.now();
  console.log("Opening terminal...");
  await shell.exec("nohup gnome-terminal &>/dev/null &");
  // Poll until terminal process appears
  await vm.pollUntil(
    "terminal",
    async () => {
      const output = await shell.exec("pgrep -x gnome-terminal");
      return output.trim().length > 0;
    },
    10000
  );
  // Click on the terminal to ensure it has focus
  await shell.dotoolCommand("mousemove 640 400");
  await Bun.sleep(200);
  await shell.dotoolCommand("buttondown 1");
  await Bun.sleep(100);
  await shell.dotoolCommand("buttonup 1");
  await Bun.sleep(1000);
  timing("open-terminal", t);

  t = Date.now();
  await vm.captureFrame("02-terminal-open");
  timing("capture-frame", t);

  // Step 3: Type echo command
  t = Date.now();
  console.log("Typing echo command...");
  await shell.dotoolCommand('type echo "');
  await Bun.sleep(1000);
  timing("type-echo", t);

  t = Date.now();
  await vm.captureFrame("03-echo-typed");
  timing("capture-frame", t);

  // Step 4: Start recording via hotkey
  t = Date.now();
  console.log("Starting recording via hotkey...");
  await shell.sendHotkey();
  await shell.waitForRecordingStart();
  timing("start-recording", t);

  t = Date.now();
  await vm.captureFrame("04-recording-started");
  timing("capture-frame", t);

  // Step 5: Wait for transcription
  t = Date.now();
  console.log("Waiting for transcription...");
  let transcription = "";
  try {
    transcription = await shell.waitForTranscription(30000);
    console.log(`  Got: ${transcription}`);
  } catch {
    console.log("  TIMEOUT - continuing anyway");
  }
  timing("transcription", t);

  t = Date.now();
  await vm.captureFrame("05-transcription-received");
  timing("capture-frame", t);

  // Step 6: Stop recording
  t = Date.now();
  console.log("Stopping recording via hotkey...");
  await shell.sendHotkey();
  await Bun.sleep(500); // Brief pause for hotkey processing
  timing("stop-recording", t);

  t = Date.now();
  await vm.captureFrame("06-recording-stopped");
  timing("capture-frame", t);

  // Step 7: Write result to file
  t = Date.now();
  console.log("Writing result to file...");
  if (transcription) {
    await shell.exec(`echo '${transcription}' > /tmp/file.txt`);
  } else {
    console.log("  WARNING: No transcription captured");
    await shell.exec("echo '' > /tmp/file.txt");
  }
  await Bun.sleep(1000);
  timing("write-result", t);
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
