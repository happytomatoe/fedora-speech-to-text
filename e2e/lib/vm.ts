import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { QemuMonitor } from "./qemu.js";
import { RunContext } from "./run-context.js";
import { Deployer } from "./deploy.js";
import { ShellHelper } from "./shell.js";
import { pollUntil, pollForProcess, pollForCommandOutput } from "./poll.js";
import {
  DeployConfig,
  waitForGdmLogin,
  installDependencies,
  deployExtension,
  deployPythonSource,
  deployTestAudio,
  startVoiceService,
} from "./deploy-steps.js";

export interface VmConfig {
  run: RunContext;
  baseImage: string;
  vmDir: string;
  sshKey: string;
  sshUser: string;
  projectRoot: string;
  pythonSrc: string;
  fixtureDir: string;
  extensionUuid: string;
  recordMode: boolean;
  updateMode: boolean;
  testAudioFile: string;
  outputMethod?: string;
  skipDeps?: boolean;
}

export class VmManager {
  process: ReturnType<typeof Bun.spawn> | null = null;
  booted = false;
  private freshlyBooted = false;
  qemu: QemuMonitor;
  deployer: Deployer;
  shell: ShellHelper;
  frameCount = 0;

  private deployCfg: DeployConfig;

  constructor(private config: VmConfig) {
    this.qemu = new QemuMonitor(config.run.socketPath);
    this.deployer = new Deployer({
      host: "localhost",
      port: config.run.sshPort,
      username: config.sshUser,
      privateKey: readFileSync(config.sshKey),
    });
    this.shell = new ShellHelper();
    this.deployCfg = {
      projectRoot: config.projectRoot,
      pythonSrc: config.pythonSrc,
      fixtureDir: config.fixtureDir,
      sshKey: config.sshKey,
      sshPort: config.run.sshPort,
      sshUser: config.sshUser,
      extensionUuid: config.extensionUuid,
      testAudioFile: config.testAudioFile,
      outputMethod: config.outputMethod,
    };
    if (config.recordMode) {
      mkdirSync(join(config.run.outputDir, "recording"), { recursive: true });
    }
  }

  // --- VM lifecycle ---

  async captureFrame(label: string): Promise<void> {
    if (!this.config.recordMode) return;
    const dir = join(this.config.run.outputDir, "recording");
    const path = join(dir, `frame-${String(this.frameCount++).padStart(4, "0")}-${label}.ppm`);
    try {
      await this.qemu.screendump(path);
      console.log(`  [rec] ${label}`);
    } catch {
      // Ignore screendump errors
    }
  }

  async boot(): Promise<void> {
    const { baseImage, vmDir, updateMode } = this.config;
    const { socketPath, overlayImage, sshPort } = this.config.run;

    if (await this.isVmRunning()) {
      console.log("VM already running, shutting down for clean restart...");
      await this.qemu.connect();
      try {
        await this.qemu.systemPowerdown();
        await Bun.sleep(3000);
      } catch {
        // Force kill if powerdown fails
      }
      // Force kill QEMU process if still running
      try {
        Bun.spawnSync(["pkill", "-f", `qemu-system.*${overlayImage}`]);
        await Bun.sleep(1000);
      } catch {
        // Ignore
      }
    }

    // Check if overlay is corrupted by verifying its backing file chain
    // A missing socket alone is NOT evidence of corruption — QEMU removes
    // the socket on normal shutdown. Only delete if the overlay is actually unusable.
    const staleOverlay = existsSync(overlayImage) && (() => {
      try {
        const info = Bun.spawnSync(["qemu-img", "info", "--output=json", overlayImage]);
        if (info.exitCode !== 0) return true; // corrupted/unreadable
        const parsed = JSON.parse(info.stdout.toString());
        return !parsed?.['backing-filename']; // missing backing file = corrupt
      } catch {
        return true; // can't inspect = assume stale
      }
    })();

    Bun.spawnSync(["rm", "-f", socketPath]);

    if (updateMode || staleOverlay || !existsSync(overlayImage)) {
      console.log("Creating fresh VM overlay...");
      const proc = Bun.spawnSync([
        "qemu-img", "create", "-f", "qcow2",
        "-b", baseImage, "-F", "qcow2", overlayImage,
      ]);
      if (proc.exitCode !== 0) throw new Error(`Failed to create overlay: ${proc.stderr.toString()}`);
    } else {
      console.log("Reusing existing overlay...");
    }

    // Use setsid to run QEMU in a new session so it survives parent abort/timeout
    const qemuArgs = [
      "qemu-system-x86_64",
      "-enable-kvm",
      "-cpu", "host",
      "-m", "4096",
      "-smp", "2",
      "-drive", `file=${overlayImage},format=qcow2,if=virtio`,
      "-device", "virtio-vga",
      "-display", "none",
      "-spice", `port=${this.config.run.spicePort},disable-ticketing=on`,
      "-monitor", `unix:${socketPath},server,nowait`,
      "-serial", `file:${this.config.run.serialLog}`,
      "-netdev", `user,id=net0,hostfwd=tcp::${sshPort}-:22`,
      "-device", "virtio-net-pci,netdev=net0",
      "-device", "virtio-rng-pci",
      "-cdrom", join(vmDir, "cloud-init.iso"),
      "-no-reboot",
    ];
    // Wrap in setsid + nohup to detach from parent process group
    const wrappedCmd = `setsid nohup ${qemuArgs.join(" ")} &>/dev/null &`;
    this.process = Bun.spawn(["sh", "-c", wrappedCmd], {
      cwd: vmDir,
      stdout: "inherit",
      stderr: "inherit",
    });

    this.booted = true;
    this.freshlyBooted = true;

    for (let i = 0; i < 30; i++) {
      if (existsSync(socketPath)) break;
      await Bun.sleep(500);
    }
    if (!existsSync(socketPath)) {
      throw new Error("QEMU monitor socket never appeared — QEMU may have failed to start");
    }

    await this.qemu.connect();
    await this.verifySpice();
  }

  async waitForSsh(): Promise<void> {
    await this.shell.openSshSession({
      sshKey: this.config.sshKey,
      sshPort: this.config.run.sshPort,
      sshUser: this.config.sshUser,
    });
  }

  /** Verify Spice display is accessible */
  async verifySpice(): Promise<void> {
    const spicePort = this.config.run.spicePort;
    const net = await import("node:net");
    
    await pollUntil(
      `Spice port ${spicePort} listening`,
      async () => {
        return new Promise<boolean>((resolve) => {
          const sock = net.createConnection(spicePort, "localhost");
          const timer = setTimeout(() => {
            sock.destroy();
            resolve(false);
          }, 2000);
          sock.on("connect", () => {
            clearTimeout(timer);
            sock.destroy();
            resolve(true);
          });
          sock.on("error", () => {
            clearTimeout(timer);
            resolve(false);
          });
        });
      },
      10000
    );
  }

  async setup(): Promise<void> {
    const t0 = Date.now();
    const shellExec = this.shell.exec.bind(this.shell);
    if (this.freshlyBooted) {
      await waitForGdmLogin(shellExec);
    } else {
      console.log("VM already booted, skipping GDM wait...");
    }
    console.log(`  GDM login: ${Date.now() - t0}ms`);

    // Establish deployer SSH connection (after GDM login, before deployment)
    await this.deployer.connect();

    const t1 = Date.now();
    const isGoldenDepsImage = this.config.baseImage.includes('golden-gnome-deps');
    if (this.config.skipDeps || isGoldenDepsImage) {
      const reason = this.config.skipDeps ? '--skip-deps' : 'golden-gnome-deps image (deps pre-installed)';
      console.log(`  Skipping installDependencies (${reason})`);
    } else {
      await installDependencies(this.config.sshKey, this.config.run.sshPort, this.config.sshUser);
    }
    // D-Bus address is obtained via getShellDbusAddr() in shell.ts as needed
    console.log(`  installDependencies: ${Date.now() - t1}ms`);

    const t2 = Date.now();
    await deployExtension(this.shell, this.deployCfg, pollUntil, this.deployer);
    console.log(`  deployExtension: ${Date.now() - t2}ms`);

    // Deploy Python source and test audio (sequential, sync operations)
    const t3 = Date.now();
    deployPythonSource(this.deployCfg);
    deployTestAudio(this.deployCfg);
    console.log(`  deploy Python+audio: ${Date.now() - t3}ms`);

    const t4 = Date.now();
    // Always install Python deps (golden image may be missing onnxruntime)
    await startVoiceService(this.shell, this.deployCfg, pollUntil, pollForCommandOutput, false);
    console.log(`  startVoiceService: ${Date.now() - t4}ms`);

    console.log(`  setup total: ${Date.now() - t0}ms`);
    // Note: snapshot save/restore is handled by saveCleanSnapshot/resetToCleanState
  }

  /**
   * Minimal setup for preferences tests - skip voice service and Python deployment.
   */
  async setupForPrefs(): Promise<void> {
    const t0 = Date.now();
    const shellExec = this.shell.exec.bind(this.shell);
    if (this.freshlyBooted) {
      await waitForGdmLogin(shellExec);
    } else {
      console.log("VM already booted, skipping GDM wait...");
    }
    console.log(`  GDM login: ${Date.now() - t0}ms`);

    // Establish deployer SSH connection
    await this.deployer.connect();

    // Deploy extension via install.sh --local
    await deployExtension(this.shell, this.deployCfg, pollUntil, this.deployer);
    console.log(`  setupForPrefs total: ${Date.now() - t0}ms`);
  }

  // --- Snapshot management ---
  async hasSnapshot(tag: string): Promise<boolean> {
    try {
      // Check if the overlay file exists and has snapshots (without booting VM)
      if (!existsSync(this.config.run.overlayImage)) return false;
      const result = Bun.spawnSync(["qemu-img", "snapshot", "-l", this.config.run.overlayImage]);
      const output = result.stdout.toString();
      return output.includes(tag);
    } catch {
      return false;
    }
  }

  async saveCleanSnapshot(tag = "clean"): Promise<void> {
    console.log(`Preparing clean snapshot '${tag}'...`);
    
    // 1. Ensure Activities is closed
    await this.shell.dismissActivities();
    await this.shell.waitActivitiesFullyClosed();
    await Bun.sleep(500);
    
    // 2. Close any open windows (show desktop)
    await this.shell.dotoolCommand("key super+d");
    await Bun.sleep(500);
    
    // 3. Wait for GNOME Shell to settle
    await Bun.sleep(1000);
    
    // 4. Save the snapshot
    await this.qemu.savevm(tag);
    console.log(`  Saved '${tag}' snapshot`);
    
    // 5. Verify snapshot exists
    const info = await this.qemu.infoSnapshots();
    if (!info.includes(tag)) {
      throw new Error(`Snapshot save failed — not found in info snapshots`);
    }
  }

  async resetToCleanState(tag = "clean", retries = 2): Promise<void> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        console.log(`Restoring clean snapshot '${tag}' (attempt ${attempt + 1})...`);
        
        // 1. Restore snapshot
        await this.qemu.loadvm(tag);
        
        // 2. Wait for guest OS to settle
        await Bun.sleep(2000);
        
        // 3. Reconnect SSH session (TCP connections are stale after restore)
        await this.shell.close();
        await this.shell.openSshSession({
          sshKey: this.config.sshKey,
          sshPort: this.config.run.sshPort,
          sshUser: this.config.sshUser,
        });
        
        // 4. Verify voice service is accessible
        await this.pollForCommandOutput(
          "busctl --user list 2>/dev/null | grep com.happytomatoe.VoiceToText",
          "com.happytomatoe.VoiceToText",
          10000
        );

        // 5. Reset JS-side recording state (snapshot restore doesn't reset this)
        this.shell.resetRecordingState();
        
        console.log("  Snapshot restored successfully");
        return;
      } catch (err) {
        console.error(`  Attempt ${attempt + 1} failed:`, err);
        if (attempt === retries) throw err;
        await Bun.sleep(1000);
      }
    }
  }

  async hasSnapshot(name: string): Promise<boolean> {
    try {
      const info = await this.qemu.infoSnapshots();
      return info.includes(name);
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.booted) {
      console.log("VM was not started by this run, skipping shutdown");
      this.qemu.close();
      await this.shell.close();
      await this.deployer.disconnect();
      return;
    }
    
    // Delete snapshot if it exists
    try {
      if (await this.hasSnapshot("clean")) {
        await this.qemu.delvm("clean");
      }
    } catch {
      // Ignore — snapshot may not exist
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

  // --- Polling (thin wrappers for convenience) ---

  async pollUntil(
    desc: string,
    check: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs = 1000
  ): Promise<void> {
    return pollUntil(desc, check, timeoutMs, intervalMs);
  }

  async pollForProcess(processName: string, timeoutMs = 10000): Promise<void> {
    return pollForProcess(this.shell.exec.bind(this.shell), processName, timeoutMs);
  }

  async pollForCommandOutput(command: string, expected: string, timeoutMs = 10000): Promise<void> {
    return pollForCommandOutput(this.shell.exec.bind(this.shell), command, expected, timeoutMs);
  }

  // --- Private ---

  private async isVmRunning(): Promise<boolean> {
    const net = await import("node:net");
    if (!existsSync(this.config.run.socketPath)) return false;
    try {
      const sock = net.createConnection(this.config.run.socketPath);
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
}
