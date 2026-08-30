import { execSync } from "node:child_process";
import { Deployer } from "./deploy.js";

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

  // Fallback: spawn new SSH connection
  const sshOpts = `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${t.sshKey} -p ${t.sshPort}`;
  const sshHost = `${t.sshUser}@localhost`;
  return execSync(`ssh ${sshOpts} ${sshHost} "${cmd}"`, { encoding: "utf-8" }).trim();
}

/** Capture the visible pane content as plain text */
export async function capturePane(t: TmuxHelper, sessionName = "e2e"): Promise<string> {
  return await tmuxCmd(t, "capture-pane", "-t", sessionName, "-p");
}

/** Kill a tmux session */
export async function killSession(t: TmuxHelper, sessionName = "e2e"): Promise<void> {
  try {
    await tmuxCmd(t, "kill-session", "-t", sessionName);
  } catch {
    // Ignore
  }
}
