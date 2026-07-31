import { ShellUse } from "@microsoft/shell-use";

export interface ShellSession {
  shell: ShellUse;
  sshKey: string;
  sshPort: number;
  sshUser: string;
  host: string;
}

export class ShellHelper {
  private session: ShellSession | null = null;

  async openSshSession(opts: {
    sshKey: string;
    sshPort: number;
    sshUser: string;
    host?: string;
    cols?: number;
    rows?: number;
  }): Promise<ShellSession> {
    const shell = new ShellUse("e2e-ssh");

    await shell.open({
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
    });

    const host = opts.host ?? "localhost";
    await shell.submit(
      `ssh -i ${opts.sshKey} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p ${opts.sshPort} ${opts.sshUser}@${host}`
    );

    // Wait for shell prompt
    await shell.waitText("$", { timeout: 60000 });

    this.session = { shell, ...opts, host };
    return this.session;
  }

  async exec(command: string, timeoutMs = 30000): Promise<string> {
    if (!this.session) throw new Error("No session");

    // Capture screen text before command
    const before = await this.session.shell.text();
    const beforeLen = before.length;
    
    await this.session.shell.submit(command);
    await this.session.shell.waitCommand({ timeout: timeoutMs });
    
    // Get full screen text after command
    const after = await this.session.shell.text();
    
    // Extract only the NEW text that appeared after the command
    // Find where the command appears in the after text
    const cmdIdx = after.lastIndexOf(command);
    if (cmdIdx >= 0) {
      const output = after.slice(cmdIdx + command.length);
      // Remove trailing prompt and whitespace
      return output.replace(/\n[^\n]*\$[ ]?$/, "").trim();
    }
    // Fallback: return everything after the before text length
    return after.slice(beforeLen).trim();
  }

  async dotoolCommand(command: string): Promise<void> {
    await this.exec(
      `export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe; echo '${command}' | /home/testuser/.local/bin/dotoolc`
    );
  }

  async sendHotkey(): Promise<void> {
    await this.dotoolCommand("key super+w");
  }

  async waitForTranscription(timeoutMs = 30000): Promise<string> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const output = await this.exec(
        `grep -oP 'Transcription result: \\K.*' /tmp/voice-service.log 2>/dev/null | tail -1`
      );

      if (output.trim()) {
        return output.trim();
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
    if (this.session) {
      await this.session.shell.close();
      this.session = null;
    }
  }
}
