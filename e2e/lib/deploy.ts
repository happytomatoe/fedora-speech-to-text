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

  constructor(config: DeployConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      this.client = new Client();

      this.client
        .on("ready", () => {
          this.connected = true;
          resolve();
        })
        .on("error", reject)
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
    await this.exec(`mkdir -p ${resolvedRemote}`);

    const entries = readdirSync(localDir);

    for (const entry of entries) {
      const local = join(localDir, entry);
      const remote = `${resolvedRemote}/${entry}`;
      const stat = statSync(local);

      if (stat.isDirectory()) {
        await this.exec(`mkdir -p ${remote}`);
        await this.uploadDir(local, remote);
      } else {
        await this.uploadFile(local, remote);
      }
    }
  }

  async exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    await this.connect();

    return new Promise((resolve, reject) => {
      this.client!.exec(command, (err, stream) => {
        if (err) {
          reject(err);
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

        stream.on("close", (code: number | null) => {
          resolve({ stdout, stderr, code: code ?? 1 });
        });
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    return new Promise((resolve) => {
      this.client!.end();
      this.client!.on("close", () => {
        this.connected = false;
        resolve();
      });
    });
  }
}
