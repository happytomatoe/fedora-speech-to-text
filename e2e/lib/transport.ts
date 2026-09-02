/** Transport seam: how the suite executes commands on the "target machine".
 *
 * - SshTransport: one-shot `ssh` CLI exec + `scp` file transfer into a VM (existing behavior).
 * - LocalTransport: `bash -lc` on the host itself + plain fs copy — used by the ubuntu-bare
 *   env where the suite runs INSIDE the same dbus-run-session as the headless
 *   gnome-shell, so no SSH hop exists.
 */

import { execSync } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface Transport {
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  /** Copy a local file/dir to the target. LocalTransport: plain fs copy. */
  copyTo(localPath: string, remotePath: string): Promise<void>;
  /** Copy a file from the target to local. LocalTransport: plain fs copy. */
  copyFrom(remotePath: string, localPath: string): Promise<void>;
}

export interface SshSessionInfo {
  sshKey: string;
  sshPort: number;
  sshUser: string;
  host: string;
}

function sshOpts(session: SshSessionInfo): string {
  return `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${session.sshKey} -p ${session.sshPort}`;
}

export class SshTransport implements Transport {
  constructor(private session: SshSessionInfo) {}

  private scpOpts(): string {
    return `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${this.session.sshKey} -P ${this.session.sshPort}`;
  }

  async exec(command: string, timeoutMs = 30000): Promise<ExecResult> {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      execFile(
        "ssh",
        [...sshOpts(this.session).split(" "), `${this.session.sshUser}@${this.session.host}`, command],
        { encoding: "utf-8", timeout: timeoutMs },
        (err, stdout, stderr) => {
          const code = (err as { code?: number } | null)?.code ?? (err ? 1 : 0);
          // Nonzero remote exit (e.g. grep with no match) — still resolve with output
          if (err && typeof (err as { code?: number }).code !== "number") {
            reject(err);
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr), code });
        },
      );
    });
  }

  async copyTo(localPath: string, remotePath: string): Promise<void> {
    execSync(
      `scp ${this.scpOpts()} ${shellQuote(localPath)} ${this.session.sshUser}@${this.session.host}:${shellQuote(remotePath)}`,
      { stdio: "pipe" },
    );
  }

  async copyFrom(remotePath: string, localPath: string): Promise<void> {
    execSync(
      `scp ${this.scpOpts()} ${this.session.sshUser}@${this.session.host}:${shellQuote(remotePath)} ${shellQuote(localPath)}`,
      { stdio: "pipe", timeout: 15000 },
    );
  }
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export class LocalTransport implements Transport {
  async exec(command: string, timeoutMs = 30000): Promise<ExecResult> {
    const proc = Bun.spawn(["bash", "-lc", command], {
      stdout: "pipe",
      stderr: "pipe",
      // Inherit the dbus-run-session environment (DBUS_SESSION_BUS_ADDRESS,
      // XDG_RUNTIME_DIR, WAYLAND_DISPLAY) — that is the whole point of this
      // transport: talk to the local headless session directly.
      env: process.env as Record<string, string>,
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { stdout, stderr, code };
  }

  async copyTo(localPath: string, remotePath: string): Promise<void> {
    await Bun.write(remotePath, Bun.file(localPath));
  }

  async copyFrom(remotePath: string, localPath: string): Promise<void> {
    await Bun.write(localPath, Bun.file(remotePath));
  }
}
