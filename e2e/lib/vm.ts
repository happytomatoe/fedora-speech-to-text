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
  spiceMode?: boolean;
}

export class VmManager {
  process: ReturnType<typeof Bun.spawn> | null = null;
  booted = false;
  private freshlyBooted = false;
  qemu: QemuMonitor;
  deployer: Deployer;
  shell: ShellHelper;

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
  }


  // --- VM lifecycle ---


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

    // Start Xvfb (required unless --spice mode)
    const useSpice = this.config.spiceMode ?? false;
    if (useSpice) {
      console.log("  [spice] mode: using SPICE display (no recording)");
    } else {
      const hasXvfb = await this.startXvfb();
      if (!hasXvfb) {
        throw new Error("Xvfb not found. Install it: sudo dnf install xorg-x11-server-Xvfb. Or use --spice mode.");
      }
    }

    const qemuArgs = [
      "qemu-system-x86_64",
      "-enable-kvm",
      "-cpu", "host",
      "-m", "4096",
      "-smp", "2",
      "-drive", `file=${overlayImage},format=qcow2,if=virtio`,
      "-monitor", `unix:${socketPath},server,nowait`,
      "-serial", `file:${this.config.run.serialLog}`,
      "-netdev", `user,id=net0,hostfwd=tcp::${sshPort}-:22`,
      "-device", "virtio-net-pci,netdev=net0",
      "-device", "virtio-rng-pci",
      "-cdrom", join(vmDir, "cloud-init.iso"),
      "-no-reboot",
    ];
    if (useSpice) {
      qemuArgs.push("-device", "virtio-vga", "-display", "none", "-spice", `port=${this.config.run.spicePort},disable-ticketing=on`);
    } else {
      qemuArgs.push("-device", "virtio-vga-gl", "-display", "gtk,gl=on");
    }

    // Use env to clear Wayland vars so QEMU uses X11 on Xvfb
    const qemuEnv = useSpice ? {} : { DISPLAY: ":99", WAYLAND_DISPLAY: "", XDG_SESSION_TYPE: "" };
    const envPrefix = useSpice ? "" : "env DISPLAY=:99 WAYLAND_DISPLAY= XDG_SESSION_TYPE=";
    const wrappedCmd = `${envPrefix} ${qemuArgs.join(" ")} &>/dev/null &`;
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
    if (useSpice) {
      await this.verifySpice();
    } else {
      await this.resizeQemuWindow();
    }
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
    const skipDeps = this.config.skipDeps || isGoldenDepsImage;
    await startVoiceService(this.shell, this.deployCfg, pollUntil, pollForCommandOutput, skipDeps);
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

  private recordingFfmpeg: ReturnType<typeof Bun.spawn> | null = null;
  private xvfbProcess: ReturnType<typeof Bun.spawn> | null = null;

  /** Start Xvfb virtual display for recording */
  private async startXvfb(): Promise<boolean> {
    try {
      const check = Bun.spawnSync(["which", "Xvfb"], { stdout: "pipe", stderr: "pipe" });
      if (check.exitCode !== 0) { console.log("  [xvfb] not found"); return false; }
    } catch { console.log("  [xvfb] not found"); return false; }

    // Check if Xvfb is already running on :99 (use xdotool instead of xdpyinfo which may not be installed)
    try {
      Bun.spawnSync(["xdotool", "getdisplaygeometry", ":99"], { stdout: "pipe", stderr: "pipe" });
      console.log("  [xvfb] already running on :99");
      return true;
    } catch { /* not running, start it */ }

    this.xvfbProcess = Bun.spawn(
      ["Xvfb", ":99", "-screen", "0", "1920x1080x24", "-ac", "-nolisten", "tcp"],
      { stdout: "pipe", stderr: "pipe" }
    );
    for (let i = 0; i < 20; i++) {
      if (this.xvfbProcess.exitCode !== null) { console.log("  [xvfb] failed to start"); return false; }
      try {
        Bun.spawnSync(["xdotool", "getdisplaygeometry", ":99"], { stdout: "pipe", stderr: "pipe" });
        console.log("  [xvfb] started on :99 (1920x1080)");
        return true;
      } catch { /* ignore */ }
      await Bun.sleep(100);
    }
    console.log("  [xvfb] failed to start");
    this.xvfbProcess?.kill("SIGKILL");
    this.xvfbProcess = null;
    return false;
  }

  /** Resize QEMU window to fill Xvfb display */
  private async resizeQemuWindow(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      try {
        const result = Bun.spawnSync(["xdotool", "search", "--name", "QEMU"], {
          stdout: "pipe", stderr: "pipe", env: { ...process.env, DISPLAY: ":99", WAYLAND_DISPLAY: "" }
        });
        const wids = result.stdout.toString().trim().split("\n").filter(Boolean);
        if (wids.length > 0) {
          const wid = wids[wids.length - 1];
          Bun.spawnSync(["xdotool", "windowsize", wid, "1920", "1080"], {
            stdout: "pipe", stderr: "pipe", env: { ...process.env, DISPLAY: ":99", WAYLAND_DISPLAY: "" }
          });
          console.log("  [xvfb] QEMU window resized to 1920x1080");
          return;
        }
      } catch { /* ignore */ }
      await Bun.sleep(500);
    }
    console.log("  [xvfb] could not find QEMU window to resize");
  }

  /** Start continuous recording via x11grab + ffmpeg */
  /** Start continuous recording via x11grab + ffmpeg (Xvfb mode only) */
  startRecording(): void {
    if (this.config.spiceMode) {
      console.log("  [recording] skipped: SPICE mode has no x11grab support");
      return;
    }
    if (this.recordingFfmpeg) return;
    const dir = join(this.config.run.outputDir, "recording");
    mkdirSync(dir, { recursive: true });
    const videoPath = join(dir, "recording.mp4");
    this.recordingFfmpeg = Bun.spawn(
      ["ffmpeg", "-y", "-f", "x11grab", "-draw_mouse", "0", "-i", ":99.0",
        "-framerate", "30", "-c:v", "libx264", "-r", "30", videoPath],
      { stdout: "pipe", stderr: "pipe" }
    );
    console.log(`  [recording] started → ${videoPath}`);
  }

  /** Stop recording and return the video file path */
  async stopRecording(): Promise<string> {
    const videoPath = join(this.config.run.outputDir, "recording", "recording.mp4");
    if (!this.recordingFfmpeg) return videoPath;
    this.recordingFfmpeg.kill("SIGINT");
    // Wait for ffmpeg to flush and exit
    for (let i = 0; i < 10; i++) {
      if (this.recordingFfmpeg.exitCode !== null) break;
      await Bun.sleep(500);
    }
    this.recordingFfmpeg = null;
    console.log(`  [recording] stopped → ${videoPath}`);
    return videoPath;
  }

  async shutdown(): Promise<void> {
    if (!this.booted) {
      console.log("VM was not started by this run, skipping shutdown");
      this.qemu.close();
      await this.shell.close();
      await this.deployer.disconnect();
      return;
    }
    // Stop recording and Xvfb before shutdown
    this.recordingFfmpeg?.kill("SIGINT");
    this.xvfbProcess?.kill("SIGKILL");
    
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
