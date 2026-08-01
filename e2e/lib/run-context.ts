import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
    this.id = customId ?? randomUUID().slice(0, 8);
    this.runDir = mkdtempSync(`/tmp/e2e-run-${this.id}-`);
    this.overlayImage = join(this.runDir, "overlay.qcow2");
    this.socketPath = join(this.runDir, "qemu-monitor.sock");
    this.sshPort = this.findAvailablePort(2222, 2299);
    this.spicePort = this.findAvailablePort(5930, 5999);
    this.outputDir = join(this.runDir, "output");
    this.serialLog = join(this.runDir, "serial.log");

    // Create fresh overlay from base image
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
    try {
      rmSync(this.runDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
