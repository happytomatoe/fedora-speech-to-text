import { execSync, spawnSync } from "node:child_process";

const VM_NAME = "e2e";

/**
 * Wrapper around virsh commands for VM lifecycle management.
 * Uses qemu:///session (user session libvirt, no root required).
 */
export class Virsh {
  /** Check if VM exists */
  static exists(): boolean {
    try {
      execSync(`virsh -c qemu:///session dominfo ${VM_NAME}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /** Start the VM */
  static start(): void {
    execSync(`virsh -c qemu:///session start ${VM_NAME}`, { stdio: "pipe" });
  }

  /** Force stop (destroy) the VM */
  static destroy(): void {
    try {
      execSync(`virsh -c qemu:///session destroy ${VM_NAME}`, { stdio: "pipe" });
    } catch {
      // VM may not be running
    }
  }

  /** Undefine the VM (removes config + snapshots) */
  static undefine(): void {
    try {
      execSync(`virsh -c qemu:///session undefine ${VM_NAME} --remove-all-storage`, { stdio: "pipe" });
    } catch {
      // VM may not exist
    }
  }

  /** Check if VM is running */
  static isRunning(): boolean {
    try {
      const out = execSync(`virsh -c qemu:///session domstate ${VM_NAME}`, { stdio: "pipe" }).toString();
      return out.trim() === "running";
    } catch {
      return false;
    }
  }

  /** Execute HMP command via virsh */
  /** Execute HMP (Human Monitor Protocol) command via virsh qemu-monitor-command. */
  static hmp(command: string, timeoutMs = 10000): string {
    const result = spawnSync(
      "virsh",
      ["-c", "qemu:///session", "qemu-monitor-command", VM_NAME, "--hmp", command],
      { timeout: timeoutMs, stdio: "pipe" }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || "";
      throw new Error(`HMP command failed (${result.status}): ${stderr}`);
    }
    return result.stdout.toString().trim();
  }

  /** Take a screenshot */
  static screendump(path: string): void {
    this.hmp(`screendump ${path}`);
  }

  /** Save a snapshot */
  static savevm(tag: string, timeoutMs = 60_000): void {
    this.hmp(`savevm ${tag}`, timeoutMs);
  }

  /** Restore a snapshot */
  static loadvm(tag: string, timeoutMs = 30_000): void {
    this.hmp(`loadvm ${tag}`, timeoutMs);
  }

  /** Delete a snapshot */
  /** Delete a snapshot */
  static deleteSnapshot(tag: string): void {
    this.hmp(`delvm ${tag}`);
  }

  /** List snapshots */
  static infoSnapshots(): string {
    return this.hmp(`info snapshots`);
  }

  /** Graceful powerdown */
  static systemPowerdown(): void {
    this.hmp(`system_powerdown`);
  }

  /** Get SSH port from domain XML */
  static getSshPort(): number {
    const xml = execSync(`virsh -c qemu:///session dumpxml ${VM_NAME}`, { stdio: "pipe" }).toString();
    const match = xml.match(/hostfwd.*?tcp::(\d+)-:22/);
    return match ? parseInt(match[1]) : 2222;
  }

}
