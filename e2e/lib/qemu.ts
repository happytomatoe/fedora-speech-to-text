import net from "node:net";
import { EventEmitter } from "node:events";

/**
 * QEMU Human Monitor (HMP) client via Unix socket.
 * Uses a persistent net.Socket connection for reliable command execution.
 */
export class QemuMonitor extends EventEmitter {
  private sock: net.Socket | null = null;
  private sockPath: string;
  private buffer = "";
  private waitingForPrompt = false;
  private promptCallback: ((output: string) => void) | null = null;
  private commandQueue: Array<() => void> = [];
  private executing = false;

  constructor(sockPath: string) {
    super();
    this.sockPath = sockPath;
  }

  /**
   * Connect to the QEMU monitor socket.
   * Waits for the initial "(qemu) " prompt.
   */
  async connect(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.sockPath);
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(new Error(`Connection timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      sock.on("connect", () => {
        if (settled) return;
        sock.removeListener("error", onError);
        this.sock = sock;
        // Keep a persistent error handler for post-connection errors
        this.sock.on("error", (err) => { if (this.listenerCount("error") > 0) this.emit("error", err); });
        // Handle socket close during connect (before prompt arrives)
        sock.on("close", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error("Socket closed before QEMU prompt"));
          }
        });
        // Wait for the initial "(qemu) " prompt — timer stays alive until prompt arrives
        this.waitingForPrompt = true;
        this.promptCallback = () => {
          clearTimeout(timer);
          resolve();
        };
      });

      sock.on("data", (data) => this.onData(data));

      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          sock.destroy();
          reject(err);
        }
      };
      sock.on("error", onError);
    });
  }

  private onData(data: Buffer): void {
    const text = data.toString();
    this.buffer += text;

    // Wait for prompt (qemu)  — but the first one is the echo of the prompt
    // before our command. The real response comes after a second (qemu) 
    // once QEMU has finished processing. Count occurrences to skip the echo.
    const prompt = "(qemu) ";
    let idx = -1;
    let count = 0;
    while ((idx = this.buffer.indexOf(prompt, idx + 1)) !== -1) {
      count++;
    }
    // After sending a command, we expect: echo prompt + command + response + response prompt
    // So we need at least 2 prompts in the buffer
    if (count >= 2 && this.waitingForPrompt && this.promptCallback) {
      const output = this.buffer;
      this.buffer = "";
      this.waitingForPrompt = false;
      const cb = this.promptCallback;
      this.promptCallback = null;
      cb(output);
    }
  }

  /**
   * Execute an HMP command and return the response text.
   * Strips ANSI escape codes, echo, and prompt from output.
   */
  async execute(command: string, timeoutMs = 10000): Promise<string> {
    if (!this.sock) throw new Error("Not connected — call connect() first");

    // Serialize commands - HMP is strictly request/response
    return new Promise<string>((resolve, reject) => {
      const run = async () => {
        this.executing = true;
        try {
          const result = await this._execute(command, timeoutMs);
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this.executing = false;
          // Process next command in queue
          const next = this.commandQueue.shift();
          if (next) next();
        }
      };

      if (this.executing) {
        this.commandQueue.push(run);
      } else {
        run();
      }
    });
  }

  private async _execute(command: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      // Reset buffer to avoid stale data from previous commands
      this.buffer = "";
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.waitingForPrompt = false;
        this.promptCallback = null;
        this.buffer = "";
        this.sock?.removeListener("error", onError);
        this.sock?.removeListener("close", onClose);
      };

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          // Destroy socket on timeout to prevent dirty state
          this.sock?.destroy();
          this.sock = null;
          reject(new Error(`Command "${command}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      const onClose = () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Socket closed while waiting for command response"));
        }
      };

      this.waitingForPrompt = true;
      this.promptCallback = (output) => {
        if (!settled) {
          settled = true;
          cleanup();

          // Strip ANSI escape codes and carriage returns
          const clean = output
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
            .replace(/\r/g, "");

          // The echo of the command appears as concatenated partial commands
          // (typewriter effect). Remove everything up to the first newline
          // after stripping, which is where the actual response begins.
          const firstNl = clean.indexOf("\n");
          const afterEcho = firstNl >= 0 ? clean.slice(firstNl + 1) : clean;

          // Filter lines: remove QEMU header, prompt, empty lines
          const lines = afterEcho.split("\n").filter((line) => {
            const trimmed = line.trim();
            return (
              trimmed &&
              !trimmed.startsWith("QEMU") &&
              !trimmed.startsWith("(qemu)")
            );
          });

          resolve(lines.join("\n").trim());
        }
      };

      this.sock!.once("error", onError);
      this.sock!.once("close", onClose);
      this.sock!.write(command + "\n");
    });
  }

  async screendump(path: string): Promise<void> {
    await this.execute(`screendump ${path}`);
  }

  async savevm(tag: string, timeoutMs = 60_000): Promise<void> {
    await this.execute(`savevm ${tag}`, timeoutMs);
  }

  async loadvm(tag: string, timeoutMs = 30_000): Promise<void> {
    await this.execute(`loadvm ${tag}`, timeoutMs);
  }

  async delvm(tag: string): Promise<void> {
    await this.execute(`delvm ${tag}`);
  }

  async systemPowerdown(): Promise<void> {
    await this.execute("system_powerdown");
  }

  async queryStatus(): Promise<string> {
    return await this.execute("info status");
  }

  async infoSnapshots(): Promise<string> {
    return await this.execute("info snapshots");
  }

  close(): void {
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
    this.buffer = "";
    this.waitingForPrompt = false;
    this.promptCallback = null;
  }
}
