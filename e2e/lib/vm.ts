import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { QemuMonitor } from "./qemu.js";
import { Deployer } from "./deploy.js";
import { ShellHelper } from "./shell.js";
import { pollUntil, pollForProcess, pollForCommandOutput } from "./poll.js";
import {
  DeployConfig,
  waitForGdmLogin,
  extractDbusAddress,
  deployExtension,
  deployPythonSource,
  deployTestAudio,
  startVoiceService,
} from "./deploy-steps.js";

export interface VmConfig {
  socketPath: string;
  baseImage: string;
  overlayImage: string;
  vmDir: string;
  sshKey: string;
  sshPort: number;
  sshUser: string;
  projectRoot: string;
  pythonSrc: string;
  fixtureDir: string;
  outputDir: string;
  extensionUuid: string;
  recordMode: boolean;
  updateMode: boolean;
  testAudioFile: string;
}

export class VmManager {
  process: ReturnType<typeof Bun.spawn> | null = null;
  booted = false;
  qemu: QemuMonitor;
  deployer: Deployer;
  shell: ShellHelper;
  frameCount = 0;

  private deployCfg: DeployConfig;

  constructor(private config: VmConfig) {
    this.qemu = new QemuMonitor(config.socketPath);
    this.deployer = new Deployer({
      host: "localhost",
      port: config.sshPort,
      username: config.sshUser,
      privateKey: readFileSync(config.sshKey),
    });
    this.shell = new ShellHelper();
    this.deployCfg = {
      projectRoot: config.projectRoot,
      pythonSrc: config.pythonSrc,
      fixtureDir: config.fixtureDir,
      sshKey: config.sshKey,
      sshPort: config.sshPort,
      sshUser: config.sshUser,
      extensionUuid: config.extensionUuid,
      testAudioFile: config.testAudioFile,
    };
    if (config.recordMode) {
      mkdirSync(join(config.outputDir, "recording"), { recursive: true });
    }
  }

  // --- VM lifecycle ---

  async captureFrame(label: string): Promise<void> {
    if (!this.config.recordMode) return;
    const dir = join(this.config.outputDir, "recording");
    const path = join(dir, `frame-${String(this.frameCount++).padStart(4, "0")}-${label}.ppm`);
    try {
      await this.qemu.screendump(path);
      console.log(`  [rec] ${label}`);
    } catch {
      // Ignore screendump errors
    }
  }

  async boot(): Promise<void> {
    const { socketPath, baseImage, overlayImage, vmDir, sshPort, updateMode } = this.config;

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

    Bun.spawnSync(["rm", "-f", socketPath]);

    if (updateMode || !existsSync(overlayImage)) {
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
      "-spice", `port=5930,disable-ticketing=on`,
      "-monitor", `unix:${socketPath},server,nowait`,
      "-serial", "file:serial.log",
      "-netdev", `user,id=net0,hostfwd=tcp::${sshPort}-:22`,
      "-device", "virtio-net-pci,netdev=net0",
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

    for (let i = 0; i < 30; i++) {
      if (existsSync(socketPath)) break;
      await Bun.sleep(500);
    }

    await this.qemu.connect();
  }

  async waitForSsh(): Promise<void> {
    await this.shell.openSshSession({
      sshKey: this.config.sshKey,
      sshPort: this.config.sshPort,
      sshUser: this.config.sshUser,
    });
  }

  async setup(): Promise<void> {
    const shellExec = this.shell.exec.bind(this.shell);

    await waitForGdmLogin(shellExec);
    await extractDbusAddress(this.shell);
    await deployExtension(this.shell, this.deployCfg, pollUntil);

    // Parallelize independent setup steps after GDM restart
    deployPythonSource(this.deployCfg);
    deployTestAudio(this.deployCfg);

    await startVoiceService(this.shell, this.deployCfg, pollUntil, pollForCommandOutput);

    if (this.config.updateMode) {
      console.log("Saving VM snapshot for hot boot...");
      await this.qemu.savevm("ready");
      await Bun.sleep(2000);
    }
  }

  // --- Snapshot management ---

  async saveCleanSnapshot(): Promise<void> {
    console.log("Preparing clean snapshot...");
    
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
    await this.qemu.savevm("clean");
    console.log("  Saved 'clean' snapshot");
    
    // 5. Verify snapshot exists
    const info = await this.qemu.infoSnapshots();
    if (!info.includes("clean")) {
      throw new Error("Snapshot save failed — not found in info snapshots");
    }
  }

  async resetToCleanState(retries = 2): Promise<void> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        console.log(`Restoring clean snapshot (attempt ${attempt + 1})...`);
        
        // 1. Restore snapshot
        await this.qemu.loadvm("clean");
        
        // 2. Wait for guest OS to settle
        await Bun.sleep(2000);
        
        // 3. Reconnect SSH session (TCP connections are stale after restore)
        await this.shell.close();
        await this.shell.openSshSession({
          sshKey: this.config.sshKey,
          sshPort: this.config.sshPort,
          sshUser: this.config.sshUser,
        });
        
        // 4. Verify voice service is accessible
        await this.pollForCommandOutput(
          "busctl --user list 2>/dev/null | grep com.happytomatoe.VoiceToText",
          "com.happytomatoe.VoiceToText",
          10000
        );
        
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
    if (!existsSync(this.config.socketPath)) return false;
    try {
      const sock = net.createConnection(this.config.socketPath);
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
