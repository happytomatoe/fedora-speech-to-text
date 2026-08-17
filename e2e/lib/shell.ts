import { sshExec } from "./deploy-steps.js";

export class ShellHelper {
  private isRecording = false;
  private dbusAddr: string | null = null;
  private _deployer: import("./deploy.js").Deployer | null = null;
  private _sshKey = "";
  private _sshPort = 0;
  private _sshUser = "testuser";

  /** Configure SSH credentials for direct commands. Resets cached D-Bus address. */
  configure(opts: { sshKey: string; sshPort: number; sshUser: string }): void {
    this._sshKey = opts.sshKey;
    this._sshPort = opts.sshPort;
    this._sshUser = opts.sshUser;
    this.dbusAddr = null; // Reset so next call re-reads from new gnome-shell
  }

  /** Set deployer for fast SSH commands (avoids per-call connection overhead) */
  setDeployer(deployer: import("./deploy.js").Deployer): void {
    this._deployer = deployer;
  }

  /** Run a command via deployer (persistent SSH) or sshExec fallback */
  async exec(command: string, _timeoutMs = 30000): Promise<string> {
    if (this._deployer) {
      const { stdout } = await this._deployer.exec(command);
      return stdout.trim();
    }
    // Fallback: synchronous sshExec
    return sshExec(command, this._sshKey, this._sshPort, this._sshUser);
  }

  async dotoolCommand(command: string): Promise<void> {
    const escapedCommand = command.replace(/'/g, "'\\''");
    await this.exec(
      `export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe; echo '${escapedCommand}' | dotoolc`
    );
  }

  private async getShellDbusAddr(): Promise<string> {
    if (this.dbusAddr) return this.dbusAddr;
    // D-Bus session bus is always at /run/user/<uid>/bus for the test user
    this.dbusAddr = "unix:path=/run/user/1000/bus";
    return this.dbusAddr;
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
    try {
      const addr = await this.getShellDbusAddr();
      if (!addr) return;
      await this.exec(
        `DBUS_SESSION_BUS_ADDRESS=${addr} gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.freedesktop.DBus.Properties.Set org.gnome.Shell OverviewActive '<false>'`
      );
    } catch {
      // Ignore — may already be dismissed
    }
  }

  /** Dismiss Activities via keyboard Escape (always safe, no-op if already closed). */
  async dismissAndCheck(): Promise<boolean> {
    // Press Escape — dismisses Activities if open, no-op if closed
    // No D-Bus calls needed (they block when gnome-shell is busy)
    await this.dotoolCommand('key Escape');
    return false; // caller doesn't need the actual state
  }

  async waitActivitiesDismissed(timeoutMs = 5000): Promise<void> {
    // Fast path: already closed
    if (!(await this.isActivitiesOpen())) return;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!(await this.isActivitiesOpen())) return;
      await Bun.sleep(200);
    }
  }

  async focusTerminal(): Promise<void> {
    await this.dotoolCommand("mousemove 640 400");
    await this.dotoolCommand("buttondown 1");
    await this.dotoolCommand("buttonup 1");
    await Bun.sleep(300);
    await this.dotoolCommand("key Escape");
    await Bun.sleep(200);
  }

  async waitActivitiesFullyClosed(timeoutMs = 5000): Promise<void> {
    // Fast path: already closed — no transition needed
    if (!(await this.isActivitiesOpen())) return;
    const start = Date.now();
    let wasOpen = true;
    
    while (Date.now() - start < timeoutMs) {
      const isOpen = await this.isActivitiesOpen();
      if (wasOpen && !isOpen) {
        await Bun.sleep(500);
        return;
      }
      wasOpen = isOpen;
      await Bun.sleep(200);
    }
  }

  async verifyTerminalFocus(tmuxSession: string): Promise<boolean> {
    try {
      const before = await this.exec(`tmux capture-pane -t ${tmuxSession} -p`);
      
      await this.dotoolCommand("key shift+a");
      await Bun.sleep(200);

      const after = await this.exec(`tmux capture-pane -t ${tmuxSession} -p`);
      return before !== after;
    } catch {
      return false;
    }
  }

  async clickToFocus(x: number, y: number): Promise<void> {
    await this.dotoolCommand(`mousemove ${x} ${y}`);
    await this.dotoolCommand('buttondown 1');
    await this.dotoolCommand('buttonup 1');
    await Bun.sleep(300);
  }

  async sendHotkey(): Promise<void> {
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

  resetRecordingState(): void {
    this.isRecording = false;
  }

  async waitForRecordingStart(timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const output = sshExec(
        `grep -q 'DEBUG MODE: Simulating audio capture' /tmp/voice-service.log 2>/dev/null && echo started`,
        this._sshKey, this._sshPort, this._sshUser, 1, 5000
      );
      if (output.includes("started")) return;
      await Bun.sleep(100);
    }
  }

  async waitForTranscription(timeoutMs = 30000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const output = sshExec(
        `grep -oP 'Transcription result: \\K.*' /tmp/voice-service.log 2>/dev/null | tail -1`,
        this._sshKey, this._sshPort, this._sshUser, 1, 5000
      );
      const trimmed = output.trim();
      if (trimmed && !/^\s*(?:\[[^\]]*\]\s*)?\S+@\S+/.test(trimmed)) {
        return trimmed;
      }
      await Bun.sleep(500);
    }
    throw new Error(`Timeout waiting for transcription (${timeoutMs}ms)`);
  }

  /** No-op — no PTY session to close anymore */
  async close(): Promise<void> {
    this.dbusAddr = null;
  }
}


