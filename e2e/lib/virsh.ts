import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Virsh wrapper for libvirt VM management.
 * Uses qemu:///session (user-mode) — no root needed.
 */
export class VirshManager {
  private virsh = "virsh -c qemu:///session";
  private vmName: string;

  constructor(vmName: string) {
    this.vmName = vmName;
  }

  /**
   * Check if the VM exists.
   */
  exists(): boolean {
    try {
      execSync(`${this.virsh} dominfo ${this.vmName}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the VM is running.
   */
  isRunning(): boolean {
    try {
      const state = execSync(`${this.virsh} domstate ${this.vmName}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return state.trim() === "running";
    } catch {
      return false;
    }
  }

  /**
   * Start the VM.
   */
  start(): void {
    if (this.isRunning()) {
      console.log("VM already running");
      return;
    }
    execSync(`${this.virsh} start ${this.vmName}`, { stdio: "ignore" });
  }

  /**
   * Stop the VM (graceful shutdown).
   */
  stop(): void {
    if (!this.isRunning()) {
      console.log("VM not running");
      return;
    }
    try {
      execSync(`${this.virsh} shutdown ${this.vmName}`, { stdio: "ignore" });
    } catch {
      // Force destroy if shutdown fails
      this.destroy();
    }
  }

  /**
   * Force stop the VM.
   */
  destroy(): void {
    try {
      execSync(`${this.virsh} destroy ${this.vmName}`, { stdio: "ignore" });
    } catch {
      // Ignore if already stopped
    }
  }

  /**
   * Take a screenshot and save to path.
   * Captures framebuffer directly — no compositor needed.
   */
  screenshot(path: string): void {
    execSync(`${this.virsh} screenshot ${this.vmName} ${path}`, {
      stdio: "ignore",
    });
  }

  /**
   * Save a live snapshot.
   */
  savevm(tag: string): void {
    execSync(`${this.virsh} snapshot-create-as ${this.vmName} ${tag}`, {
      stdio: "ignore",
    });
  }

  /**
   * Restore a live snapshot.
   */
  loadvm(tag: string): void {
    execSync(`${this.virsh} snapshot-revert ${this.vmName} ${tag}`, {
      stdio: "ignore",
    });
  }

  /**
   * Delete a snapshot.
   */
  delvm(tag: string): void {
    try {
      execSync(`${this.virsh} snapshot-delete ${this.vmName} ${tag}`, {
        stdio: "ignore",
      });
    } catch {
      // Ignore if snapshot doesn't exist
    }
  }

  /**
   * Check if a snapshot exists.
   */
  hasSnapshot(tag: string): boolean {
    try {
      const output = execSync(
        `${this.virsh} snapshot-list ${this.vmName} --name`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      return output.includes(tag);
    } catch {
      return false;
    }
  }

  /**
   * Run a command via SSH.
   */
  ssh(sshKey: string, sshPort: number, sshUser: string, command: string): string {
    return execSync(
      `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ` +
        `-o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR ` +
        `-i ${sshKey} -p ${sshPort} ${sshUser}@localhost "${command}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
  }

  /**
   * Check if SSH is available.
   */
  isSshReady(sshKey: string, sshPort: number, sshUser: string): boolean {
    try {
      this.ssh(sshKey, sshPort, sshUser, "true");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if GNOME Shell is running.
   */
  isGnomeShellRunning(sshKey: string, sshPort: number, sshUser: string): boolean {
    try {
      const output = this.ssh(
        sshKey,
        sshPort,
        sshUser,
        "pgrep -x gnome-shell"
      );
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Wait for SSH to become available.
   */
  waitForSsh(
    sshKey: string,
    sshPort: number,
    sshUser: string,
    timeoutSec = 120
  ): void {
    const start = Date.now();
    while (Date.now() - start < timeoutSec * 1000) {
      if (this.isSshReady(sshKey, sshPort, sshUser)) {
        return;
      }
      execSync("sleep 2");
    }
    throw new Error(`SSH timeout after ${timeoutSec}s`);
  }

  /**
   * Wait for GNOME Shell to start.
   */
  waitForGnomeShell(
    sshKey: string,
    sshPort: number,
    sshUser: string,
    timeoutSec = 120
  ): void {
    this.waitForSsh(sshKey, sshPort, sshUser, timeoutSec);
    const start = Date.now();
    while (Date.now() - start < timeoutSec * 1000) {
      if (this.isGnomeShellRunning(sshKey, sshPort, sshUser)) {
        return;
      }
      execSync("sleep 2");
    }
    throw new Error(`GNOME Shell timeout after ${timeoutSec}s`);
  }
}
