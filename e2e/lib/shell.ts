import { execSync } from "node:child_process";

/**
 * SSH-backed helper for running commands in the VM and driving the GNOME session.
 *
 * Previously this wrapped @microsoft/shell-use (a local PTY that SSH'd into the
 * VM), but nothing needed the interactive terminal — every operation is a plain
 * command that works over a normal SSH exec channel. The PTY layer added
 * fragility (daemon crashes after GDM restart, ECONNRESET on close) with no
 * benefit, so all commands now go through the persistent ssh2 Deployer
 * connection, falling back to one-shot `ssh` CLI calls when no deployer is set.
 */

export interface ShellSession {
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

  /** Set deployer for fast persistent SSH commands */
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
    // Invalidate cached D-Bus address — the VM may have rebooted since the
    // last session (GDM restart, snapshot restore).
    this.dbusAddr = null;
    this.session = {
      sshKey: opts.sshKey,
      sshPort: opts.sshPort,
      sshUser: opts.sshUser,
      host: opts.host ?? "localhost",
    };
    return this.session;
  }

  async exec(command: string, timeoutMs = 30000): Promise<string> {
    const sshExecOnce = async (): Promise<string> => {
      if (!this.session) throw new Error("No session");
      const sshOpts = `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${this.session.sshKey} -p ${this.session.sshPort}`;
      const sshHost = `${this.session.sshUser}@${this.session.host}`;
      try {
        return execSync(`ssh ${sshOpts} ${sshHost} ${quote(command)}`, {
          encoding: "utf-8",
          timeout: timeoutMs,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch (err) {
        // Nonzero remote exit (e.g. `grep` with no match) — still return stdout
        const e = err as { stdout?: string; status?: number };
        if (typeof e.status === "number") return (e.stdout ?? "").trim();
        throw err;
      }
    };
    if (this._deployer) {
      try {
        // Race deployer.exec against a timeout — a half-open SSH connection
        // (TCP alive, peer gone after VM reboot/snapshot restore) never fires
        // "close" and would hang forever. On timeout, fall back to one-shot ssh.
        const result = await Promise.race([
          this._deployer.exec(command),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("deployer exec timeout")), Math.max(timeoutMs, 15000))
          ),
        ]);
        return result.stdout.trim();
      } catch (err) {
        // Persistent connection can die (VM reboot, snapshot restore, GDM
        // restart) — fall back to a one-shot ssh call instead of failing.
        // Also disconnect the dead deployer so subsequent calls skip it and
        // can lazily reconnect on the next call.
        console.log(`  deployer exec failed (${err instanceof Error ? err.message : err}), retrying via one-shot ssh`);
        try { await this._deployer.disconnect(); } catch { /* ignore */ }
        return sshExecOnce();
      }
    }
    return sshExecOnce();
  }

  async dotoolCommand(command: string): Promise<void> {
    // Escape single quotes in the command for safe shell interpolation
    const escapedCommand = command.replace(/'/g, "'\\''");
    await this.exec(
      `export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe; echo '${escapedCommand}' | /home/testuser/.local/bin/dotoolc`
    );
  }

  /** Run a D-Bus command via SSH with the correct session bus address. */
  private async dbusExec(command: string): Promise<string> {
    const dbusAddr = await this.getShellDbusAddr();
    if (!this._deployer) throw new Error("No deployer for dbusExec");
    const { stdout, stderr, code } = await this._deployer.exec(`DBUS_SESSION_BUS_ADDRESS='${dbusAddr}' ${command}`);
    if (code !== 0) throw new Error(`D-Bus command failed (code ${code}): stdout=${stdout} stderr=${stderr}`);
    return stdout.trim();
  }

  private async getShellDbusAddr(): Promise<string> {
    // Return cached address (D-Bus session address never changes after GNOME Shell starts)
    if (this.dbusAddr) return this.dbusAddr;
    if (!this.session) return "";
    try {
      let raw: string;
      if (this._deployer) {
        const result = await this._deployer.exec(
          `cat /proc/$(pgrep -f gnome-shell | head -1)/environ | xargs -0 -n1 | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-`
        );
        raw = result.stdout.trim();
      } else {
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
      await this.dotoolCommand("key shift+a"); // 'A' is visible, unlike space
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

  /** Start GNOME Shell screencast via D-Bus. Returns the output filename. */
  async startScreencast(fileTemplate: string): Promise<string> {
    const result = await this.dbusExec(
      `gdbus call --session --dest org.gnome.Shell.Screencast --object-path /org/gnome/Shell/Screencast --method org.gnome.Shell.Screencast.Screencast '${fileTemplate}' '{}'`
    );
    // Parse: (true, '/tmp/file.webm')
    const match = result.match(/'([^']+)'/);
    if (!match || !result.includes('true')) {
      throw new Error(`Screencast start failed: ${result}`);
    }
    return match[1];
  }

  /** Stop GNOME Shell screencast via D-Bus. */
  async stopScreencast(): Promise<void> {
    await this.dbusExec(
      `gdbus call --session --dest org.gnome.Shell.Screencast --object-path /org/gnome/Shell/Screencast --method org.gnome.Shell.Screencast.StopScreencast`
    );
  }

  async waitText(text: string, opts?: { timeout?: number }): Promise<void> {
    // Poll-based replacement for the shell-use PTY waitText: `exec` the command
    // and wait for its output to contain `text`.
    const timeout = opts?.timeout ?? 30000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const out = await this.exec(text, timeout);
      if (out.includes(text)) return;
      await Bun.sleep(200);
    }
  }

  async reconnect(): Promise<void> {
    if (this._deployer) {
      await this._deployer.disconnect();
      await this._deployer.connect();
    }
  }

  async close(): Promise<void> {
    this.dbusAddr = null; // Invalidate cached address
    this.session = null;
  }
}

/** Quote a command for the ssh CLI (double-quoted, escaping inner double quotes). */
function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}
