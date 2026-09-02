import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { QemuMonitor } from "./qemu.js";
import { RunContext } from "./run-context.js";
import { Deployer } from "./deploy.js";
import { ShellHelper } from "./shell.js";
import { pollUntil, pollForProcess, pollForCommandOutput } from "./poll.js";
import { execSync } from "node:child_process";
import type { SuiteEnv } from "./env.js";
import {
  DeployConfig,
  waitForGdmLogin,
  ensureGdmAutologin,
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
  recordMode?: boolean;
  updateMode?: boolean;
  testAudioFile: string;
  outputMethod?: string;
  skipDeps?: boolean;
  /** Environment abstraction — OS/boot specifics live here. */
  env: SuiteEnv;
  /** Attach to an already-running VM instead of booting (CI-failure repro). */
  useExisting?: boolean;
}

export class VmManager {
  process: ReturnType<typeof Bun.spawn> | null = null;
  qemuProcessPid: number | null = null;
  booted = false;
  private freshlyBooted = false;
  qemu: QemuMonitor;
  deployer: Deployer;
  shell: ShellHelper;
  frameCount = 0;
  config!: VmConfig;

  deployCfg: DeployConfig;

  constructor(config: VmConfig) {
    this.config = config;
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
      env: config.env,
    };
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

  async boot(loadvmTag?: string): Promise<void> {
    if (this.config.useExisting) {
      // Attach mode: an externally-managed VM (e.g. e2e-vm/boot-vm.sh parity
      // VM) is already running — no QEMU lifecycle of our own. waitForSsh
      // does the reachability check; setup() skips GDM wait (already logged
      // in) and QEMU-monitor screenshots fall back to D-Bus (no socket of
      // ours). Used to reproduce CI failures against the same image.
      console.log("Using existing VM (no boot)... --use-existing");
      this.booted = false;
      this.freshlyBooted = false;
      return;
    }
    const { baseImage, vmDir, updateMode } = this.config;
    const { socketPath, overlayImage, sshPort } = this.config.run;

    // vmDir is cwd for the QEMU spawn — must exist before spawn or posix_spawn
    // fails with a misleading ENOENT on 'sh'.
    mkdirSync(vmDir, { recursive: true });

    if (await this.isVmRunning()) {
      console.log("VM already running, shutting down for clean restart...");
      try {
        await this.qemu.connect();
        await this.qemu.systemPowerdown();
      } catch {
        // Force kill if powerdown fails
      }
      // Wait for QEMU to actually exit (poll, not fixed sleep) before any
      // pkill — the fallback fresh boot must never race a dying QEMU for the
      // monitor socket (observed flake: ECONNREFUSED on stale socket).
      await this.waitQemuGone(20000);
      // Force kill QEMU process if still running, then confirm it is gone.
      try {
        Bun.spawnSync(["pkill", "-f", `qemu-system.*${overlayImage}`]);
      } catch {
        // Ignore
      }
      await this.waitQemuGone(10000);
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
    // The socket must be gone before spawn: QEMU with server,nowait unlinks
    // and recreates it, but a socket left by an already-dead QEMU would make
    // the boot-time monitor connect race the new QEMU's socket creation.
    for (let i = 0; i < 20 && existsSync(socketPath); i++) await Bun.sleep(250);

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

    // Start Xvfb (required for the GTK display and x11grab recording)
    const hasXvfb = await this.startXvfb();
    if (!hasXvfb) {
      throw new Error("Xvfb not found. Install it: sudo dnf install xorg-x11-server-Xvfb.");
    }

    const qemuArgs = [
      "qemu-system-x86_64",
      "-enable-kvm",
      "-cpu", "host",
      "-m", "4096",
      "-smp", "2",
      // cache=unsafe: throwaway test VM, no host crash recovery needed —
      // skips flush barriers for faster disk I/O and snapshot restores.
      "-drive", `file=${overlayImage},format=qcow2,if=virtio,cache=unsafe`,
      "-monitor", `unix:${socketPath},server,nowait`,
      "-serial", `file:${this.config.run.serialLog}`,
      "-netdev", `user,id=net0,hostfwd=tcp::${sshPort}-:22`,
      "-device", "virtio-net-pci,netdev=net0",
      "-device", "virtio-rng-pci",
      // Fedora golden images historically boot with a cloud-init seed ISO;
      // the Ubuntu golden image has the user baked in (no seed needed).
      ...(this.config.env.os === "fedora" ? ["-cdrom", join(vmDir, "cloud-init.iso")] : []),
      "-no-reboot",
    ];
    // std VGA (Bochs-VBE) with EDID override: no resize-negotiation channel, so
    // the guest keeps its own resolution instead of shrinking to whatever size
    // the GTK window opens at (virtio-vga did that, causing small recordings
    // with padding). EDID xres/yres makes 1920x1080 the preferred mode, which
    // GNOME/mutter picks at session start.
    qemuArgs.push(
        "-device", "VGA,edid=on,xres=1920,yres=1080",
        "-display", "gtk,gl=off"
      );

    // Restore from snapshot during startup when requested — guest resumes
    // directly from snapshot instead of doing a full boot.
    if (loadvmTag) qemuArgs.push("-loadvm", loadvmTag);

    // Use env to clear Wayland vars so QEMU uses X11 on Xvfb
    const qemuEnv = { DISPLAY: ":99", WAYLAND_DISPLAY: "", XDG_SESSION_TYPE: "" };
    const envPrefix = "env DISPLAY=:99 WAYLAND_DISPLAY= XDG_SESSION_TYPE=";
    // Capture QEMU stderr to a log file for debugging
    const qemuStderrLog = join(this.config.run.runDir, "qemu-stderr.log");
    const wrappedCmd = `${envPrefix} ${qemuArgs.join(" ")} 2>"${qemuStderrLog}" &`;
    this.process = Bun.spawn(["sh", "-c", wrappedCmd], {
      cwd: vmDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    // Give QEMU a moment to start and create the monitor socket
    await Bun.sleep(1000);

    this.booted = true;
    this.freshlyBooted = true;

    // Wait for QEMU monitor socket to appear (up to 30s)
    for (let i = 0; i < 60; i++) {
      if (existsSync(socketPath)) break;
      await Bun.sleep(500);
      if (i % 10 === 9) console.log(`  [boot] waiting for monitor socket... (${(i + 1) * 500}ms)`);
    }
    if (!existsSync(socketPath)) {
      throw new Error("QEMU monitor socket never appeared after 30s — QEMU may have failed to start");
    }

    // Track the actual QEMU process, not the launcher shell — the shell exits
    // immediately (trailing `&`), so killing it in shutdown() wouldn't stop QEMU.
    const qemuPid = Bun.spawnSync(["pgrep", "-f", `qemu-system.*${overlayImage}`]).stdout.toString().trim().split("\n")[0];
    this.qemuProcessPid = qemuPid ? Number(qemuPid) : null;

    await this.qemu.connect();
  }
  /** Poll until no qemu-system process for this overlay remains. */
  private async waitQemuGone(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const out = Bun.spawnSync(["pgrep", "-f", `qemu-system.*${this.config.run.overlayImage}`]).stdout.toString().trim();
      if (!out) return;
      await Bun.sleep(500);
    }
    console.log("  [boot] warning: QEMU still running after shutdown wait");
  }

  async waitForSsh(): Promise<void> {
    // Wait for a full SSH handshake, not just an open port — sshd may accept
    // the TCP connection but reset during the handshake on a fresh boot under
    // load, which makes the ssh2 Deployer connections flake with ECONNRESET.
    await this.waitForSshHandshake();
    await this.shell.openSshSession({
      sshKey: this.config.sshKey,
      sshPort: this.config.run.sshPort,
      sshUser: this.config.sshUser,
    });
  }

  async waitForSshHandshake(timeoutMs = 90000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = Bun.spawnSync(
        [
          "ssh",
          "-i", this.config.sshKey,
          "-p", String(this.config.run.sshPort),
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "BatchMode=yes",
          "-o", "ConnectTimeout=5",
          `${this.config.sshUser}@localhost`,
          "true",
        ],
        { stderr: "ignore", stdout: "ignore" },
      );
      if (res.exitCode === 0) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("SSH handshake did not succeed within timeout");
  }


  async setup(): Promise<void> {
    const t0 = Date.now();
    // Establish deployer SSH connection first (needed for waitForGdmLogin)
    await this.deployer.connect();

    if (this.freshlyBooted) {
      await ensureGdmAutologin(this.deployer, this.config.sshUser, this.config.env);
      await waitForGdmLogin(this.deployer);
    } else {
      console.log("VM already booted, skipping GDM wait...");
    }
    console.log(`  GDM login: ${Date.now() - t0}ms`);

    const t1 = Date.now();
    // ponytail: golden-gnome-deps.qcow2 (Aug 8) predates onnxruntime in the dep
    // list (Aug 27) — image is stale, so deps are ALWAYS installed until the
    // golden image is rebuilt. Restore the skip when image is refreshed.
    const isGoldenDepsImage = false;
    if (this.config.skipDeps || isGoldenDepsImage) {
      const reason = this.config.skipDeps ? '--skip-deps' : 'golden-gnome-deps image (deps pre-installed)';
      console.log(`  Skipping installDependencies (${reason})`);
    } else {
      await installDependencies(this.config.env, this.config.sshKey, this.config.run.sshPort, this.config.sshUser);
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
    // Establish deployer SSH connection first (needed for waitForGdmLogin)
    await this.deployer.connect();

    if (this.freshlyBooted) {
      await ensureGdmAutologin(this.deployer, this.config.sshUser, this.config.env);
      await waitForGdmLogin(this.deployer);
    } else {
      console.log("VM already booted, skipping GDM wait...");
    }
    console.log(`  GDM login: ${Date.now() - t0}ms`);

    // Deploy extension via install.sh --local
    await deployExtension(this.shell, this.deployCfg, pollUntil, this.deployer);
    console.log(`  setupForPrefs total: ${Date.now() - t0}ms`);
  }

  // --- Snapshot management ---
  async hasSnapshot(tag: string): Promise<boolean> {
    try {
      // Check if the overlay file exists and has snapshots (without booting VM)
      if (!existsSync(this.config.run.overlayImage)) return false;
      // -U/--force-share: QEMU may hold a write lock on the overlay (VM
      // running), which would otherwise make this command fail and look like
      // "no snapshot".
      const result = Bun.spawnSync(["qemu-img", "snapshot", "-l", "-U", this.config.run.overlayImage]);
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

  /** Reconnect shell and verify guest state after a snapshot restore (-loadvm or loadvm). */
  async reconnectAfterRestore(): Promise<void> {
    await Bun.sleep(2000);
    await this.shell.openSshSession({
      sshKey: this.config.sshKey,
      sshPort: this.config.run.sshPort,
      sshUser: this.config.sshUser,
    });
    await this.pollForCommandOutput(
      "busctl --user list 2>/dev/null | grep 'com.happytomatoe.[V]oiceToText'",
      "com.happytomatoe.VoiceToText",
      10000
    );
    this.shell.resetRecordingState();
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
        await this.shell.reconnect();
        await this.shell.openSshSession({
          sshKey: this.config.sshKey,
          sshPort: this.config.run.sshPort,
          sshUser: this.config.sshUser,
        });
        
        // 4. Verify voice service is accessible
        await this.pollForCommandOutput(
          "busctl --user list 2>/dev/null | grep 'com.happytomatoe.[V]oiceToText'",
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
  private recordingCodec = "mpeg4";
  private xvfbProcess: ReturnType<typeof Bun.spawn> | null = null;

  /** Start Xvfb virtual display for recording */
  private async startXvfb(): Promise<boolean> {
    try {
      const check = Bun.spawnSync(["which", "Xvfb"], { stdout: "pipe", stderr: "pipe" });
      if (check.exitCode !== 0) { console.log("  [xvfb] not found"); return false; }
    } catch { console.log("  [xvfb] not found"); return false; }

    // Check if Xvfb is already running on :99 — probe the X socket directly.
    // (xdotool inherits XAUTHORITY from the Wayland session and fails with
    // "Authorization required" even when Xvfb is up.)
    if (existsSync("/tmp/.X11-unix/X99")) {
      // Stale-socket check: Xvfb may have died and left the socket behind
      // ("gtk initialization failed" in QEMU). If no Xvfb process owns it,
      // remove the socket and start a fresh Xvfb.
      const pgrep = Bun.spawnSync(["pgrep", "-x", "Xvfb"]);
      const hasLiveXvfb = pgrep.exitCode === 0 && pgrep.stdout.toString().trim().length > 0;
      if (hasLiveXvfb) {
        console.log("  [xvfb] already running on :99");
        return true;
      }
      console.log("  [xvfb] stale /tmp/.X11-unix/X99 socket (no Xvfb process) — removing");
      try { Bun.spawnSync(["rm", "-f", "/tmp/.X11-unix/X99"]); } catch { /* ignore */ }
    }

    this.xvfbProcess = Bun.spawn(
      ["Xvfb", ":99", "-screen", "0", "1920x1080x24", "-ac", "-nolisten", "tcp"],
      { stdout: "pipe", stderr: "pipe" }
    );
    // Give Xvfb a moment to initialize before probing
    await Bun.sleep(200);
    for (let i = 0; i < 20; i++) {
      if (this.xvfbProcess.exitCode !== null) { console.log("  [xvfb] failed to start"); return false; }
      try {
        if (existsSync("/tmp/.X11-unix/X99")) {
          console.log("  [xvfb] started on :99 (1920x1080)");
          return true;
        }
      } catch { /* ignore */ }
      await Bun.sleep(100);
    }
    console.log("  [xvfb] failed to start");
    this.xvfbProcess?.kill("SIGKILL");
    this.xvfbProcess = null;
    return false;
  }

  /** Resize QEMU window to fill Xvfb display */

  /** Start continuous recording via x11grab (Xvfb mode only) */
  startRecording(): void {
    if (this.recordingFfmpeg) return;
    const dir = join(this.config.run.outputDir, "recording");
    mkdirSync(dir, { recursive: true });
    const videoPath = join(dir, "recording.mp4");
    // Fedora ships ffmpeg-free: no libx264, and libopenh264 is a non-functional
    // stub ("noopenh264"). Probe for a real H.264 encoder, else fall back to
    // mpeg4 (always present in ffmpeg-free, plays everywhere, bigger file).
    let codec = "mpeg4";
    try {
      const encoders = execSync("ffmpeg -hide_banner -encoders 2>/dev/null", { encoding: "utf-8" });
      if (encoders.includes("libx264")) codec = "libx264";
      else if (encoders.includes("libopenh264") && existsSync("/usr/lib64/libopenh264.so.8") && statSync("/usr/lib64/libopenh264.so.8").size > 100_000) codec = "libopenh264";
    } catch { /* ffmpeg probe failed — mpeg4 fallback */ }
    this.recordingFfmpeg = Bun.spawn(
      ["ffmpeg", "-y", "-f", "x11grab", "-draw_mouse", "0", "-i", ":99.0",
        "-framerate", "30", "-c:v", codec, "-pix_fmt", "yuv420p", "-r", "30", videoPath],
      { stdout: "pipe", stderr: "pipe" }
    );
    this.recordingCodec = codec;
    // Check if ffmpeg failed immediately (e.g., codec not available, display not found)
    if (this.recordingFfmpeg.exitCode !== null) {
      const stderr = this.recordingFfmpeg.stderr?.toString() || "";
      console.log(`  [recording] ffmpeg exited immediately (code=${this.recordingFfmpeg.exitCode}): ${stderr.slice(0, 200)}`);
      this.recordingFfmpeg = null;
      return;
    }
    console.log(`  [recording] started → ${videoPath} (codec=${codec})`);
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
    this.trimRecordingHead(videoPath);
    return videoPath;
  }

  /**
   * Fire-and-forget post-process: cut the pre-activity idle head from the
   * recording so the video keeps only ~1s of context before the widget
   * appears. freezedetect (n=0.001, d=0.5) finds the first freeze_end =
   * activity start; we re-encode with the same H.264 encoder probing as
   * startRecording (mpeg4 output does not play in browsers). Designed to run
   * in parallel with VM shutdown, so it adds no wall time.
   */
  private trimRecordingHead(videoPath: string): void {
    const scriptPath = join(import.meta.dir, "trim-recording.sh");
    Bun.spawn(["bash", scriptPath, videoPath], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, TRIM_CODEC: this.recordingCodec },
    });
  }

  async shutdown(): Promise<void> {
    if (!this.booted) {
      console.log("VM was not started by this run, skipping shutdown");
      this.qemu.close();
      try {
        await this.shell.close();
      } catch {
        // Ignore — connection may already be gone
      }
      await this.deployer.disconnect();
      return;
    }
    // Stop recording and Xvfb before shutdown
    this.recordingFfmpeg?.kill("SIGINT");
    this.xvfbProcess?.kill("SIGKILL");
    
    // Delete snapshot if it exists
    try {
      if (await this.hasSnapshot("clean")) {
        await this.qemu.deleteSnapshot("clean");
      }
    } catch {
      // Ignore — snapshot may not exist
    }
    
    try {
      // Monitor `quit` terminates immediately — throwaway VM, graceful ACPI
      // powerdown cost ~5s of waitQemuGone polling for nothing.
      await this.qemu.quit();
      await this.waitQemuGone(5000);
    } finally {
      if (this.qemuProcessPid) {
        try { Bun.spawnSync(["kill", "-9", String(this.qemuProcessPid)]); } catch { /* already gone */ }
      }
      this.process?.kill("SIGKILL");
      this.qemu.close();
      try {
        await this.shell.close();
      } catch (err) {
        // Ignore — connection may already be gone
        console.log(`  shell close warning: ${err instanceof Error ? err.message : err}`);
      }
      try {
        await this.deployer.disconnect();
      } catch (err) {
        // Ignore — QEMU just died, socket teardown can surface ECONNRESET
        console.log(`  deployer disconnect warning: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // --- Polling (thin wrappers for convenience) ---

  async pollUntil(
    desc: string,
    check: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs = 100
  ): Promise<void> {
    return pollUntil(desc, check, timeoutMs, intervalMs);
  }

  async pollForProcess(processName: string, timeoutMs = 10000): Promise<void> {
    return pollForProcess(this.shell.exec.bind(this.shell), processName, timeoutMs);
  }

  async pollForCommandOutput(command: string, expected: string, timeoutMs = 10000): Promise<void> {
    const { sshExecAsync } = await import("./deploy-steps.js");
    const cfg = this.config;
    // Use one-shot ssh with swallow-on-failure: after snapshot restore the
    // persistent deployer connection is dead and would throw every attempt.
    return pollForCommandOutput(
      (cmd) => sshExecAsync(cmd, cfg.sshKey, cfg.run.sshPort, cfg.sshUser),
      command,
      expected,
      timeoutMs
    );
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
