import { Client, SFTPWrapper } from "ssh2";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = this._doConnect();
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
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
        .connect(this.config);
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
    await this.exec(`mkdir -p "${resolvedRemote}"`);

    const entries = readdirSync(localDir);

    for (const entry of entries) {
      const local = join(localDir, entry);
      const remote = `${resolvedRemote}/${entry}`;
      const stat = statSync(local);

      if (stat.isDirectory()) {
        await this.exec(`mkdir -p "${remote}"`);
        await this.uploadDir(local, remote);
      } else {
        await this.uploadFile(local, remote);
      }
    }
  }

  async exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    await this.connect();

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
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
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
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

      client.once("close", () => {
        resolve();
      });

      client.end();

      // Timeout in case close never fires
      setTimeout(() => {
        resolve();
      }, 1000);
    });
  }
}
