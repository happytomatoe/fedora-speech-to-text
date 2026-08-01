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
  private isRecording = false;

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

    // Wait for remote shell prompt (use a more specific pattern to avoid matching local prompt)
    await shell.waitText(`${opts.sshUser}@`, { timeout: 60000 });

    this.session = { shell, ...opts, host };
    return this.session;
  }

  async exec(command: string, timeoutMs = 30000): Promise<string> {
    if (!this.session) throw new Error("No session");

    // Capture screen text before command
    const before = await this.session.shell.text();
    const beforeLines = before.split("\n");
    const beforeLen = before.length;

    await this.session.shell.submit(command);
    await this.session.shell.waitCommand({ timeout: timeoutMs });

    // Get full screen text after command
    const after = await this.session.shell.text();
    const afterLines = after.split("\n");

    // Find the command in the output - look for the command followed by new output
    // Use a more robust approach: find the line containing the command
    let cmdLineIdx = -1;
    for (let i = afterLines.length - 1; i >= 0; i--) {
      if (afterLines[i].includes(command) && !afterLines[i].includes(`${command}`)) {
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
        /^\s*[a-zA-Z0-9_-]+@[\w.-]+[#$]\s*$/.test(outputLines[outputLines.length - 1])
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

  async sendHotkey(): Promise<void> {
    // Use D-Bus instead of dotool - dotool key presses don't propagate through Wayland
    const dbusAddr = await this.exec(
      `cat /proc/$(pgrep -f 'gnome-shell --mode=user' | head -1)/environ 2>/dev/null | tr '\\0' '\\n' | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-`
    );
    const dbusBase = `DBUS_SESSION_BUS_ADDRESS=${dbusAddr.trim()} dbus-send --session --type=method_call --dest=com.happytomatoe.VoiceToText /com/happytomatoe/VoiceToText`;

    if (this.isRecording) {
      await this.exec(`${dbusBase} com.happytomatoe.VoiceToText.StopRecording`);
      this.isRecording = false;
    } else {
      await this.exec(`${dbusBase} com.happytomatoe.VoiceToText.StartRecording string:'{"provider":"parakeet","language":"en","output_method":"type"}'`);
      this.isRecording = true;
    }
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
