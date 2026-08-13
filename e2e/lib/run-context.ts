import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

export interface RunConfig {
  baseImage: string;
  sshKey: string;
  sshUser: string;
  projectRoot: string;
  pythonSrc: string;
  fixtureDir: string;
  extensionUuid: string;
  testAudioFile: string;
  recordMode: boolean;
  updateMode: boolean;
}

export class RunContext {
  readonly id: string;
  readonly runDir: string;
  readonly overlayImage: string;
  readonly socketPath: string;
  readonly sshPort: number;
  readonly spicePort: number;
  readonly outputDir: string;
  readonly serialLog: string;

  constructor(config: RunConfig, customId?: string) {
    // In single (non-parallel) snapshot mode, use a fixed ID so overlays persist between runs.
    // Parallel workers get unique IDs to avoid socket/port conflicts.
    this.id = customId ?? (config.updateMode ? randomUUID().slice(0, 8) : "main");
    
    // In update mode, use a temp directory; otherwise use persistent directory for snapshots
    if (config.updateMode) {
      this.runDir = mkdtempSync(`/tmp/e2e-run-${this.id}-`);
    } else {
      // Each parallel worker gets its own subdirectory to avoid socket conflicts
      this.runDir = join(config.projectRoot, "e2e", "qemu-images", "persistent-run", this.id);
      mkdirSync(this.runDir, { recursive: true });
    }
    
    this.overlayImage = join(this.runDir, "overlay.qcow2");
    this.socketPath = `/tmp/qemu-monitor-${this.id}.sock`;  // Short path (UNIX socket limit: 108 bytes)
    this.sshPort = this.findAvailablePort(2222, 2299);
    this.spicePort = this.findAvailablePort(5930, 5999);
    this.outputDir = join(this.runDir, "output");
    this.serialLog = join(this.runDir, "serial.log");

    // Create fresh overlay from base image (each worker gets its own)
    if (config.updateMode || !existsSync(this.overlayImage)) {
      console.log(`Creating VM overlay in ${this.runDir}...`);
      const proc = Bun.spawnSync([
        "qemu-img", "create", "-f", "qcow2",
        "-b", config.baseImage, "-F", "qcow2", this.overlayImage,
      ]);
      if (proc.exitCode !== 0) {
        throw new Error(`Failed to create overlay: ${proc.stderr.toString()}`);
      }
    }
  }

  private findAvailablePort(min: number, max: number): number {
    for (let i = 0; i < 10; i++) {
      const port = min + Math.floor(Math.random() * (max - min));
      try {
        execSync(`ss -tlnp | grep :${port}`, { encoding: "utf-8", stdio: "pipe" });
        // Port is in use, try another
        continue;
      } catch {
        // ss grep failed = port is free
        return port;
      }
    }
    throw new Error(`No available port in range ${min}-${max}`);
  }

  cleanup(): void {
    // Don't cleanup persistent-run directory (used for snapshots)
    if (this.runDir.includes('persistent-run')) {
      return;
    }
    try {
      rmSync(this.runDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Cleanup all worker subdirectories under persistent-run
   * Called at the end of a parallel run to free disk space
   */
  static cleanupPersistentRun(projectRoot: string): void {
    const persistentRun = join(projectRoot, "e2e", "qemu-images", "persistent-run");
    if (!existsSync(persistentRun)) return;
    
    const { readdirSync } = require("node:fs");
    for (const entry of readdirSync(persistentRun)) {
      // Keep the base overlay and output directory
      if (entry === "overlay.qcow2" || entry === "output") continue;
      const entryPath = join(persistentRun, entry);
      try {
        rmSync(entryPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
