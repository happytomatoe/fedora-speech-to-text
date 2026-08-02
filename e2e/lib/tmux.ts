import { execSync } from "node:child_process";
import { Deployer } from "./deploy.js";

export interface TmuxHelper {
  session: string;
  sshKey: string;
  sshPort: number;
  sshUser: string;
  deployer?: Deployer;
}

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

/** Create a new tmux session with a shell */
export async function createSession(t: TmuxHelper, sessionName = "e2e"): Promise<void> {
  // Kill any existing session
  try {
    await tmuxCmd(t, "kill-session", "-t", sessionName);
  } catch {
    // Ignore if session doesn't exist
  }
  await tmuxCmd(t, "new-session", "-d", "-s", sessionName, "-x", "120", "-y", "40");
}

/** Send keystrokes to a tmux session (like dotool but for tmux) */
export async function sendKeys(t: TmuxHelper, keys: string, sessionName = "e2e"): Promise<void> {
  await tmuxCmd(t, "send-keys", "-t", sessionName, keys);
}

/** Send a key combination (e.g., "C-c", "Enter") */
export async function sendKey(t: TmuxHelper, key: string, sessionName = "e2e"): Promise<void> {
  await tmuxCmd(t, "send-keys", "-t", sessionName, key);
}

/** Capture the visible pane content as plain text */
export async function capturePane(t: TmuxHelper, sessionName = "e2e"): Promise<string> {
  return await tmuxCmd(t, "capture-pane", "-t", sessionName, "-p");
}

/** Capture pane including scrollback history */
export async function capturePaneHistory(t: TmuxHelper, sessionName = "e2e"): Promise<string> {
  return await tmuxCmd(t, "capture-pane", "-t", sessionName, "-p", "-S", "-1000");
}

/** Wait for text to appear in the pane */
export async function waitForText(
  t: TmuxHelper,
  text: string,
  timeoutMs = 30000,
  intervalMs = 500,
  sessionName = "e2e"
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = await capturePane(t, sessionName);
    if (content.includes(text)) {
      return content;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for text '${text}' in tmux session`);
}

/** Kill a tmux session */
export async function killSession(t: TmuxHelper, sessionName = "e2e"): Promise<void> {
  try {
    await tmuxCmd(t, "kill-session", "-t", sessionName);
  } catch {
    // Ignore
  }
}
