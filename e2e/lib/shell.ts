import { ShellUse } from "@microsoft/shell-use";
import { execSync } from "node:child_process";

export interface ShellSession {
  shell: ShellUse;
  sshKey: string;
  sshPort: number;
  sshUser: string;
  host: string;
}

export class ShellHelper {
  private session: ShellSession | null = null;
  private isRecording = false;

  private dbusAddr: string | null = null;
  private _deployer: import("./deploy.js").Deployer | null = null;

  /** Set deployer for fast SSH commands (avoids per-call connection overhead) */
  setDeployer(deployer: import("./deploy.js").Deployer): void {
    this._deployer = deployer;
  }

  async openSshSession(opts: {
    sshKey: string;
    sshPort: number;
    sshUser: string;
    host?: string;
    cols?: number;
    rows?: number;
  }): Promise<ShellSession> {
    // Retry shell-use daemon connection — it can crash after GDM restart
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let shell: ShellUse | null = null;
      try {
        shell = new ShellUse("e2e-ssh");
        await shell.open({
          cols: opts.cols ?? 120,
          rows: opts.rows ?? 40,
        });

        const host = opts.host ?? "localhost";
        await shell.submit(
          `ssh -i ${opts.sshKey} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p ${opts.sshPort} ${opts.sshUser}@${host}`
        );

        // Wait for remote shell prompt (use a more specific pattern to avoid matching local prompt)
        await shell.waitText(`${opts.sshUser}@localhost`, { timeout: 60000 });

        this.session = { shell, ...opts, host };
        return this.session;
      } catch (err) {
        lastErr = err as Error;
        console.log(`  SSH session attempt ${attempt + 1} failed: ${lastErr.message}`);
        // Close the failed instance to avoid resource leak
        try {
          await shell?.close();
        } catch { /* ignore */ }
        if (attempt < 2) {
          // Kill any stale daemon session and wait before retry
          // Scope the pkill to this specific session to avoid killing unrelated sessions
          try {
            execSync(`pkill -f 'shell-use.*e2e-ssh' 2>/dev/null || true`, { stdio: "pipe" });
          } catch { /* ignore */ }
          await Bun.sleep(3000);
        }
      }
    }
    throw lastErr ?? new Error("Failed to open SSH session after 3 attempts");
  }

  async exec(command: string, timeoutMs = 30000): Promise<string> {
    if (!this.session) throw new Error("No session");

    // Capture screen text before command
    const before = await this.session.shell.text();
    const beforeLen = before.length;

    await this.session.shell.submit(command);
    // Wait for the shell prompt to reappear after command completes
    await this.session.shell.waitText(`${this.session.sshUser}@localhost`, { timeout: timeoutMs });

    // Get full screen text after command
    const after = await this.session.shell.text();
    const afterLines = after.split("\n");

    // Find the command in the output - look for the command followed by new output
    // Use a more robust approach: find the line containing the command
    let cmdLineIdx = -1;
    for (let i = afterLines.length - 1; i >= 0; i--) {
      if (afterLines[i].includes(command)) {
        cmdLineIdx = i;
        break;
      }
    }

    if (cmdLineIdx >= 0) {
      // Get everything after the command line
      const outputLines = afterLines.slice(cmdLineIdx + 1);

      // Remove trailing prompt lines (lines ending with $ or #)
      while (
        outputLines.length > 0 &&
        /^\s*(?:\[[^\]]*\]\s*)?\S+@\S+(?:\s+\S+)*\s*[#$]\s*$/.test(outputLines[outputLines.length - 1])
      ) {
        outputLines.pop();
      }

      return outputLines.join("\n").trim();
    }

    // Fallback: return everything after the before text length
    return after.slice(beforeLen).trim();
  }

  async dotoolCommand(command: string): Promise<void> {
    // Escape single quotes in the command for safe shell interpolation
    const escapedCommand = command.replace(/'/g, "'\\''");
    await this.exec(
      `export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe; echo '${escapedCommand}' | /home/testuser/.local/bin/dotoolc`
    );
  }

  private async getShellDbusAddr(): Promise<string> {
    // Return cached address (D-Bus session address never changes after GNOME Shell starts)
    if (this.dbusAddr) return this.dbusAddr;
    if (!this.session) return "";
    try {
      let raw: string;
      if (this._deployer) {
        // Fast path: use persistent SSH connection (avoids ~6s per-call overhead)
        const result = await this._deployer.exec(
          `cat /proc/$(pgrep -f gnome-shell | head -1)/environ | xargs -0 -n1 | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-`
        );
        raw = result.stdout.trim();
      } else {
        // Fallback: spawn new SSH connection
        const sshOpts = `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${this.session.sshKey} -p ${this.session.sshPort}`;
        const sshHost = `${this.session.sshUser}@${this.session.host}`;
        raw = execSync(
          `ssh ${sshOpts} ${sshHost} 'cat /proc/$(pgrep -f gnome-shell | head -1)/environ | xargs -0 -n1 | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-'`,
          { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
      }
      if (raw) {
        this.dbusAddr = raw;
      }
      return raw;
    } catch {
      return "";
    }
  }

  async isActivitiesOpen(): Promise<boolean> {
    try {
      const addr = await this.getShellDbusAddr();
      if (!addr) return false;
      const result = await this.exec(
        `DBUS_SESSION_BUS_ADDRESS=${addr} gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.freedesktop.DBus.Properties.Get org.gnome.Shell OverviewActive`
      );
      return result.includes('(<true>,)');
    } catch {
      return false;
    }
  }

  async dismissActivities(): Promise<void> {
    if (!this.session) return;
    try {
      const addr = await this.getShellDbusAddr();
      if (!addr) return;
      // Use execSync directly (like tmuxCmd) to avoid shell.exec() screen capture
      // interference during Activities dismiss
      const sshOpts = `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${this.session.sshKey} -p ${this.session.sshPort}`;
      const sshHost = `${this.session.sshUser}@${this.session.host}`;
      execSync(
        `ssh ${sshOpts} ${sshHost} "DBUS_SESSION_BUS_ADDRESS=${addr} gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.freedesktop.DBus.Properties.Set org.gnome.Shell OverviewActive '<false>'" 2>/dev/null`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch {
      // Ignore — may already be dismissed
    }
  }

  async waitActivitiesDismissed(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!(await this.isActivitiesOpen())) return;
      await Bun.sleep(200);
    }
    // Fall through — may already be dismissed
  }

  /**
   * Force-focus the terminal window using gio launch.
   * This ensures the terminal receives keyboard input after Activities dismiss.
   */
  /**
   * Focus the terminal window by clicking on it.
   * Does NOT use gio launch (that opens a new window).
   */
  async focusTerminal(): Promise<void> {
    // Click on the terminal area to ensure it has focus
    await this.dotoolCommand("mousemove 640 400");
    await this.dotoolCommand("buttondown 1");
    await this.dotoolCommand("buttonup 1");
    await Bun.sleep(300);
    // Send Escape to dismiss any popup/search that might be open
    await this.dotoolCommand("key Escape");
    await Bun.sleep(200);
  }

  /**
   * Wait for Activities overview to be fully closed (including animation).
   * Polls until OverviewActive is false AND waits for animation to settle.
   */
  async waitActivitiesFullyClosed(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    let wasOpen = false;
    
    while (Date.now() - start < timeoutMs) {
      const isOpen = await this.isActivitiesOpen();
      if (wasOpen && !isOpen) {
        // Activities just closed — wait for animation to complete
        await Bun.sleep(500);
        return;
      }
      wasOpen = isOpen;
      await Bun.sleep(100);
    }
    // Fall through — may already be closed
  }

  /**
   * Verify terminal has focus by typing a test character.
   * Returns true if tmux content changed (terminal was focused).
   */
  async verifyTerminalFocus(tmuxSession: string, sshKey: string, sshPort: number): Promise<boolean> {
    try {
      // Get tmux content before
      const before = execSync(
        `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${sshKey} -p ${sshPort} ${this.session?.sshUser}@${this.session?.host} "tmux capture-pane -t ${tmuxSession} -p"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      // Type a test character
      await this.dotoolCommand("key shift+a");  // 'A' is visible, unlike space
      await Bun.sleep(200);

      // Get tmux content after
      const after = execSync(
        `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${sshKey} -p ${sshPort} ${this.session?.sshUser}@${this.session?.host} "tmux capture-pane -t ${tmuxSession} -p"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      return before !== after;
    } catch {
      return false;
    }
  }

  /**
   * Click to focus a window at given coordinates.
   */
  async clickToFocus(x: number, y: number): Promise<void> {
    await this.dotoolCommand(`mousemove ${x} ${y}`);
    await this.dotoolCommand('buttondown 1');
    await this.dotoolCommand('buttonup 1');
    await Bun.sleep(300);
  }

  async sendHotkey(): Promise<void> {
    // Use D-Bus instead of dotool - dotool key presses don't propagate through Wayland
    const dbusAddr = await this.getShellDbusAddr();
    const dbusBase = `DBUS_SESSION_BUS_ADDRESS='${dbusAddr}' gdbus call --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText --method`;

    if (this.isRecording) {
      await this.exec(`${dbusBase} com.happytomatoe.VoiceToText.StopRecording`);
      this.isRecording = false;
    } else {
      await this.exec(`${dbusBase} com.happytomatoe.VoiceToText.StartRecording '{"provider":"parakeet","language":"en","output_method":"type"}'`);
      this.isRecording = true;
    }
  }

  /** Reset recording state flag (used after snapshot restore) */
  resetRecordingState(): void {
    this.isRecording = false;
  }
  async waitForRecordingStart(timeoutMs = 10000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const output = await this.exec(
        `grep -q 'DEBUG MODE: Simulating audio capture' /tmp/voice-service.log 2>/dev/null && echo started`
      );

      if (output.includes("started")) {
        return;
      }

      await Bun.sleep(100);
    }
    // Fall through - recording may have started but log check didn't catch it
  }

  async waitForTranscription(timeoutMs = 30000): Promise<string> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const output = await this.exec(
        `grep -oP 'Transcription result: \\K.*' /tmp/voice-service.log 2>/dev/null | tail -1`
      );

      const trimmed = output.trim();
      // Filter out shell prompts that weren't stripped
      if (trimmed && !/^\s*(?:\[[^\]]*\]\s*)?\S+@\S+/.test(trimmed)) {
        return trimmed;
      }

      await Bun.sleep(500);
    }

    throw new Error(`Timeout waiting for transcription (${timeoutMs}ms)`);
  }

  async screenshot(path: string): Promise<void> {
    if (!this.session) throw new Error("No session");
    await this.session.shell.screenshot(path);
  }

  async waitText(text: string, opts?: { timeout?: number }): Promise<void> {
    if (!this.session) throw new Error("No session");
    await this.session.shell.waitText(text, opts);
  }

  async close(): Promise<void> {
    this.dbusAddr = null;  // Invalidate cached address
    if (this.session) {
      await this.session.shell.close();
      this.session = null;
    }

}
}
