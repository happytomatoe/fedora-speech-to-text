import { execSync } from "node:child_process";
import { Deployer } from "./deploy.js";
import { SshTransport } from "./transport.js";

export interface TmuxHelper {
  session: string;
  sshKey: string;
  sshPort: number;
  sshUser: string;
  deployer?: Deployer;
}

/** Run a tmux command inside the VM and return its output. */
async function tmuxCmd(t: TmuxHelper, ...args: string[]): Promise<string> {
  const escaped = args.map(a => a.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
  const cmd = `tmux ${escaped.join(' ')}`;

  if (t.deployer) {
    // Fast path: use persistent SSH connection (avoids ~6s per-call overhead)
    const result = await t.deployer.exec(cmd);
    return result.stdout.trim();
  }

  // Fallback: one-shot ssh via the SshTransport seam
  const transport = new SshTransport({ sshKey: t.sshKey, sshPort: t.sshPort, sshUser: t.sshUser, host: "localhost" });
  const result = await transport.exec(cmd);
  return result.stdout.trim();
}

/** Capture the visible pane content as plain text */
export async function capturePane(t: TmuxHelper, sessionName = "e2e"): Promise<string> {
  return await tmuxCmd(t, "capture-pane", "-t", sessionName, "-p");
}

/** Kill a tmux session */
export async function killSession(t: TmuxHelper, sessionName = "e2e"): Promise<void> {
  try {
    await tmuxCmd(t, "kill-session", "-t", sessionName);
  } catch (err) {
    console.warn(`[tmux] kill-session failed (may already be gone): ${err instanceof Error ? err.message : err}`);
  }
}
