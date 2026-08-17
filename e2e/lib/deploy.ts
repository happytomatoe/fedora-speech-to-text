import { Client, SFTPWrapper } from "ssh2";
import { timeoutMs as configTimeoutMs } from "./config.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Escape a string for safe use in a shell command */
function shellEscape(s: string): string {
  // Use single quotes and escape any single quotes within
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
export interface DeployConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string | Buffer;
}

export class Deployer {
  private config: DeployConfig;
  private client: Client | null = null;
  private connected = false;
  private _connectPromise: Promise<void> | null = null;

  constructor(config: DeployConfig) {
    this.config = config;
  }

  async connect(maxRetries = 5, retryDelayMs = 3000): Promise<void> {
    if (this.connected) return;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = this._doConnectWithRetry(maxRetries, retryDelayMs);
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }
  private async _doConnectWithRetry(maxRetries: number, retryDelayMs: number): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this._doConnect();
        return; // Success
      } catch (err) {
        lastError = err as Error;
        console.log(`  SSH connect attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}`);
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, retryDelayMs));
        }
      }
    }
    throw lastError;
  }

  private async _doConnect(): Promise<void> {
    // Clean up any existing client
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end();
      this.client = null;
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;

      const cleanup = () => {
        client.removeAllListeners();
        if (this.client === client) {
          this.client = null;
          this.connected = false;
        }
      };

      client
        .on("ready", () => {
          if (!settled) {
            settled = true;
            this.client = client;
            this.connected = true;

            // Handle connection drops after ready
            client.on("close", () => {
              if (this.client === client) {
                this.connected = false;
                this.client = null;
              }
            });

            client.on("error", () => {
              if (this.client === client) {
                this.connected = false;
                this.client = null;
              }
            });

            resolve();
          }
        })
        .on("error", (err) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        })
        .on("close", () => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error("Connection closed before ready"));
          }
        })
        .connect({ ...this.config, readyTimeout: 30000 });
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.connect();

    // Resolve ~ in remote path for SFTP (doesn't expand ~)
    let resolvedRemote = remotePath;
    if (remotePath.startsWith("~/")) {
      const home = await this.exec("echo $HOME");
      resolvedRemote = home.stdout.trim() + remotePath.slice(1);
    }

    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }

        const data = readFileSync(localPath);
        sftp.writeFile(resolvedRemote, data, (err) => {
          sftp.end();
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  }

  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    await this.connect();

    // Resolve ~ in remote path
    let resolvedRemote = remoteDir;
    if (remoteDir.startsWith("~/")) {
      const home = await this.exec("echo $HOME");
      resolvedRemote = home.stdout.trim() + remoteDir.slice(1);
    }

    // Ensure remote directory exists
    await this.exec(`mkdir -p ${shellEscape(resolvedRemote)}`);

    // Collect all files to upload (flatten recursive tree)
    const files: Array<{ local: string; remote: string; isDir: boolean }> = [];
    const collectFiles = (ld: string, rd: string) => {
      for (const entry of readdirSync(ld)) {
        const local = join(ld, entry);
        const remote = `${rd}/${entry}`;
        const stat = statSync(local);
        if (stat.isDirectory()) {
          files.push({ local, remote, isDir: true });
          collectFiles(local, remote);
        } else {
          files.push({ local, remote, isDir: false });
        }
      }
    };
    collectFiles(localDir, resolvedRemote);

    // Upload all files through a single SFTP session
    return new Promise((resolve, reject) => {
      this.client!.sftp(async (err, sftp) => {
        if (err) {
          reject(err);
          return;
        }

        try {
          // Create all remote directories first
          for (const file of files) {
            if (file.isDir) {
              await new Promise<void>((res) => {
                sftp.mkdir(file.remote, () => res());
              });
            }
          }

          // Upload all files
          for (const file of files) {
            if (file.isDir) continue;
            const data = readFileSync(file.local);
            await new Promise<void>((res, rej) => {
              sftp.writeFile(file.remote, data, (err) => {
                if (err) rej(err);
                else res();
              });
            });
          }

          sftp.end();
          resolve();
        } catch (e) {
          sftp.end();
          reject(e);
        }
      });
    });
  }

  async exec(command: string, timeoutMs = configTimeoutMs("ssh_exec"), verbose = false): Promise<{ stdout: string; stderr: string; code: number }> {
    await this.connect();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (this.client) {
          this.client.removeListener("close", onClientClose);
        }
      };

      const onClientClose = () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("SSH connection closed during command execution"));
        }
      };

      this.client!.on("close", onClientClose);

      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`SSH exec timeout after ${timeoutMs}ms: ${command.slice(0, 80)}`));
        }
      }, timeoutMs);

      this.client!.exec(command, (err, stream) => {
        if (err) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
          return;
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          const s = data.toString();
          stdout += s;
          if (verbose) process.stdout.write(s);
        });

        stream.stderr.on("data", (data: Buffer) => {
          const s = data.toString();
          stderr += s;
          if (verbose) process.stderr.write(s);
        });

        stream.on("error", (err: Error) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        });

        stream.on("close", (code: number | null) => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve({ stdout, stderr, code: code ?? 1 });
          }
        });
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connected && !this.client) return;

    this.connected = false;

    return new Promise((resolve) => {
      if (!this.client) {
        resolve();
        return;
      }

      const client = this.client;
      this.client = null;

      const timer = setTimeout(() => {
        resolve();
      }, 1000);

      client.once("close", () => {
        clearTimeout(timer);
        resolve();
      });

      client.end();
    });
  }
}
