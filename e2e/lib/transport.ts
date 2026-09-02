/**
 * Transport seam: how the suite executes commands on the "target machine".
 *
 * - SshTransport: one-shot `ssh` CLI exec into a VM (existing behavior).
 * - LocalTransport: `bash -lc` on the host itself — used by the ubuntu-bare
 *   env where the suite runs INSIDE the same dbus-run-session as the headless
 *   gnome-shell, so no SSH hop exists.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface Transport {
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
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
}
