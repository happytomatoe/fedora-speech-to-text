import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { QemuMonitor } from "./qemu.js";
import { RunContext } from "./run-context.js";
import { Deployer } from "./deploy.js";
import { ShellHelper } from "./shell.js";
import { pollUntil, pollForProcess, pollForCommandOutput } from "./poll.js";
import { checkHealth, recordPreDeployPid, type HealthCheckResult } from "./health.js";
import {
  DeployConfig,
  waitForGdmLogin,
  installDependencies,
  deployExtension,
  deployPythonSource,
  deployTestAudio,
  startVoiceService,
  scpToVm,
  scpFromVm,
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
  private recordingFfmpeg: ReturnType<typeof Bun.spawn> | null = null;

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

  /** Fetch screenshot from VM via SSH cat + base64 (avoids SCP overhead) */
  private async fetchScreenshot(remotePath: string, localPath: string): Promise<boolean> {
    try {
      const b64 = await this.shell.exec(`base64 < ${remotePath}`);
      const buf = Buffer.from(b64, "base64");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(localPath, buf);
      return true;
    } catch {
      return false;
    }
  }

  async captureFrame(label: string): Promise<void> {
    if (!this.config.recordMode) return;
    const dir = join(this.config.run.outputDir, "recording");
    const localPath = join(dir, `frame-${String(this.frameCount++).padStart(4, "0")}-${label}.png`);
    const remotePath = "/tmp/e2e-screenshot.png";
    try {
      // Use portal screenshot for Wayland compositor capture
      await this.shell.exec(`python3 ~/portal-screenshot.py ${remotePath}`);
      const ok = await this.fetchScreenshot(remotePath, localPath);
      if (!ok) throw new Error("fetch failed");
      console.log(`  [rec] ${label}`);
    } catch {
      // Fallback to QEMU screendump
      try {
        const ppmPath = localPath.replace(".png", ".ppm");
        await this.qemu.screendump(ppmPath);
        console.log(`  [rec] ${label} (fallback)`);
      } catch {
        // Ignore all errors
      }
    }
  }

  /** Start continuous recording via VNC + ffmpeg */
  startRecording(): void {
    if (this.recordingFfmpeg) return;
    const dir = join(this.config.run.outputDir, "recording");
    mkdirSync(dir, { recursive: true });
    const videoPath = join(dir, "recording.mp4");
    this.recordingFfmpeg = Bun.spawn(
      ["ffmpeg", "-y", "-f", "vnc", "-i", "localhost:5900", "-r", "30", videoPath],
      { stdout: "pipe", stderr: "pipe", stdin: "pipe" }
    );
    console.log("  [rec] started ffmpeg VNC capture");
  }

  /** Stop recording and return video path */
  async stopRecording(): Promise<string | null> {
    if (!this.recordingFfmpeg) return null;
    const proc = this.recordingFfmpeg;
    this.recordingFfmpeg = null;
    const videoPath = join(this.config.run.outputDir, "recording", "recording.mp4");

    // Send 'q' to ffmpeg to stop gracefully
    if (proc.stdin) {
      proc.stdin.write("q");
      proc.stdin.end();
    }
    try {
      await proc.exited;
    } catch {
      // ffmpeg may exit with non-zero when killed
    }

    if (existsSync(videoPath)) {
      console.log(`  [rec] saved: ${videoPath}`);
      return videoPath;
    }
    console.log("  [rec] no video produced");
    return null;
  }

  /** Create video from PNG screenshots as fallback */
  createVideoFromScreenshots(): void {
    const dir = join(this.config.run.outputDir, "recording");
    const videoPath = join(dir, "recording.mp4");
    const pngPattern = join(dir, "frame-*.png");
    try {
      execSync(`ls ${pngPattern} 2>/dev/null | head -1`, { encoding: "utf-8" });
    } catch {
      console.log("  [rec] no PNG files for fallback");
      return;
    }
    try {
      execSync(
        `ffmpeg -y -framerate 1 -pattern_type glob -i '${pngPattern}' -c:v libx264 -r 30 -pix_fmt yuv420p "${videoPath}" 2>/dev/null`,
        { stdio: "ignore" }
      );
      if (existsSync(videoPath)) {
        console.log(`  [rec] created from screenshots: ${videoPath}`);
      }
    } catch {
      // ffmpeg not available
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
    // Check if KVM is usable (file exists + readable)
    const kvmAvailable = existsSync("/dev/kvm");
    console.log(`  KVM: ${kvmAvailable ? 'available' : 'NOT available (using TCG software emulation)'}`);
    const qemuArgs = [
      "qemu-system-x86_64",
      ...(kvmAvailable ? ["-enable-kvm", "-cpu", "host"] : ["-cpu", "max"]),
      "-m", "8192",
      "-smp", "4",
      "-drive", `file=${overlayImage},format=qcow2,if=virtio`,
      "-device", "virtio-vga",
      "-vnc", ":0",
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
    await this.verifyDisplayReady();
  }

  async waitForSsh(): Promise<void> {
    // Wait for SSH port to be reachable before shell-use connection
    const net = await import("node:net");
    const sshPort = this.config.run.sshPort;
    await pollUntil(
      `SSH port ${sshPort} listening`,
      async () => {
        return new Promise<boolean>((resolve) => {
          const sock = net.createConnection(sshPort, "localhost");
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
      120_000,
      1000
    );
    // Configure shell helper with SSH credentials (no PTY session needed)
    this.shell.configure({
      sshKey: this.config.sshKey,
      sshPort: this.config.run.sshPort,
      sshUser: this.config.sshUser,
    });
  }

  /** Verify VNC display is accessible */
  async verifyDisplayReady(): Promise<void> {
    const net = await import("node:net");
    const vncPort = 5900; // display :0 = port 5900
    
    await pollUntil(
      `VNC port ${vncPort} listening`,
      async () => {
        return new Promise<boolean>((resolve) => {
          const sock = net.createConnection(vncPort, "localhost");
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

  /** Deploy portal screenshot script for Wayland capture */
  private async deployPortalScreenshot(): Promise<void> {
    const scriptPath = join(this.config.projectRoot, "e2e/scripts/portal-screenshot.py");
    if (!existsSync(scriptPath)) {
      console.log("  [portal] script not found, skipping");
      return;
    }
    try {
      // Copy script to VM user home
      const remoteScript = "~/portal-screenshot.py";
      scpToVm(scriptPath, remoteScript, this.config.sshKey, this.config.run.sshPort, this.config.sshUser);
      await this.shell.exec("chmod +x ~/portal-screenshot.py");
      
      // Create desktop file for portal registration
      await this.shell.exec(`mkdir -p ~/.local/share/applications && cat > ~/.local/share/applications/io.github.voice-to-text-e2e.desktop << 'EOF'
[Desktop Entry]
Name=VoiceToText E2E
Exec=python3 ~/portal-screenshot.py
Type=Application
EOF`);
      
      // Pre-authorize in permission store
      await this.shell.exec(`flatpak permission-set screenshot screenshot io.github.voice-to-text-e2e yes 2>/dev/null || true`);
      
      console.log("  [portal] screenshot script deployed");
    } catch (e) {
      console.log(`  [portal] deploy failed: ${e}`);
    }
  }

  async setup(): Promise<void> {
    const t0 = Date.now();
    if (this.freshlyBooted) {
      await waitForGdmLogin(this.shell, this.config.sshKey, this.config.run.sshPort, this.config.sshUser, this.config.run.serialLog, this.deployer);
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
      await installDependencies(this.config.sshKey, this.config.run.sshPort, this.config.sshUser, this.deployer);
    }
    // D-Bus address is obtained via getShellDbusAddr() in shell.ts as needed
    console.log(`  installDependencies: ${Date.now() - t1}ms`);

    // Deploy portal screenshot script for Wayland capture
    await this.deployPortalScreenshot();

    const t2 = Date.now();
    await deployExtension(this.shell, this.deployCfg, pollUntil, this.deployer);
    console.log(`  deployExtension: ${Date.now() - t2}ms`);

    // Deploy Python source and test audio (sequential, sync operations)
    const t3 = Date.now();
    await deployPythonSource(this.deployCfg, this.deployer);
    await deployTestAudio(this.deployCfg, this.deployer);
    console.log(`  deploy Python+audio: ${Date.now() - t3}ms`);

    const t4 = Date.now();
    const skipDeps = this.config.skipDeps || isGoldenDepsImage;
    await startVoiceService(this.shell, this.deployCfg, pollUntil, pollForCommandOutput, skipDeps, this.deployer);
    console.log(`  startVoiceService: ${Date.now() - t4}ms`);

    console.log(`  setup total: ${Date.now() - t0}ms`);
    // Note: snapshot save/restore is handled by saveCleanSnapshot/resetToCleanState
  }

  /**
   * Minimal setup for preferences tests - skip voice service and Python deployment.
   */
  async setupForPrefs(): Promise<void> {
    const t0 = Date.now();
    if (this.freshlyBooted) {
      await waitForGdmLogin(this.shell, this.config.sshKey, this.config.run.sshPort, this.config.sshUser, this.config.run.serialLog, this.deployer);
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

  // --- Health checks ---

  /** Record gnome-shell PID before deployment (for crash detection). */
  async recordPreDeployPid(): Promise<string> {
    return recordPreDeployPid(this.shell.exec.bind(this.shell));
  }

  /** Run all health checks (gnome-shell alive, extension active, no JS errors, no crash). */
  async healthCheck(preDeployPid?: string): Promise<HealthCheckResult> {
    return checkHealth(
      this.shell.exec.bind(this.shell),
      this.config.extensionUuid,
      preDeployPid
    );
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
    
    // 1. Kill voice service so snapshot is clean (deploy will restart it)
    try {
      await this.shell.exec("systemctl --user stop com.happytomatoe.VoiceToText.user.service 2>/dev/null; systemctl --user disable com.happytomatoe.VoiceToText.user.service 2>/dev/null; systemctl --user stop com.happytomatoe.VoiceToText.service 2>/dev/null; killall -9 voice-to-text-dbus python3 2>/dev/null; pkill -9 -f voice-to-text 2>/dev/null; true");
      await Bun.sleep(1000);
    } catch {
      // Ignore — service may not be running
    }
    
    // 2. Ensure Activities is closed
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
        
        // 3. Invalidate D-Bus cache (session bus changes after restore)
        await this.shell.close();
        
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

  // --- Log collection ---

  /** Fetch logs from VM to local output directory for artifact upload. */
  async fetchLogs(outputDir: string): Promise<void> {
    const vmLogsDir = join(outputDir, "vm-logs");
    mkdirSync(vmLogsDir, { recursive: true });
    const logs = [
      { remote: "/tmp/voice-service.log", local: "voice-service.log" },
      { remote: "/tmp/gnome-shell.log", local: "gnome-shell.log" },
    ];
    for (const { remote, local } of logs) {
      try {
        const content = await this.shell.exec(`cat ${remote} 2>/dev/null`);
        if (content.trim()) {
          writeFileSync(join(vmLogsDir, local), content);
        }
      } catch {
        // File may not exist or SSH down — skip
      }
    }
    // Capture tmux pane content (useful for debugging terminal output)
    try {
      const paneContent = await this.shell.exec(
        `tmux capture-pane -t e2e:0 -p 2>/dev/null`
      );
      if (paneContent.trim()) {
        writeFileSync(join(vmLogsDir, "tmux-pane.txt"), paneContent);
      }
    } catch {
      // tmux may not be running — skip
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
