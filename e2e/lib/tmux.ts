import { execSync } from "node:child_process";

export interface TmuxHelper {
  session: string;
  sshKey: string;
  sshPort: number;
  sshUser: string;
}

function sshOpts(key: string, port: number): string {
  return `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${key} -p ${port}`;
}

function sshHost(user: string): string {
  return `${user}@localhost`;
}

function tmuxCmd(t: TmuxHelper, ...args: string[]): string {
  // Escape shell metacharacters individually so double-quoted args pass through correctly.
  // Wrapping each arg in single quotes (old approach) broke when args contained double quotes
  // because bash interpreted them inside the SSH command string.
  const escaped = args.map(a => a.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
  const cmd = `ssh ${sshOpts(t.sshKey, t.sshPort)} ${sshHost(t.sshUser)} "tmux ${escaped.join(' ')}"`;
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

/** Create a new tmux session with a shell */
export function createSession(t: TmuxHelper, sessionName = "e2e"): void {
  // Kill any existing session
  try {
    tmuxCmd(t, "kill-session", "-t", sessionName);
  } catch {
    // Ignore if session doesn't exist
  }
  tmuxCmd(t, "new-session", "-d", "-s", sessionName, "-x", "120", "-y", "40");
}

/** Send keystrokes to a tmux session (like dotool but for tmux) */
export function sendKeys(t: TmuxHelper, keys: string, sessionName = "e2e"): void {
  tmuxCmd(t, "send-keys", "-t", sessionName, keys);
}

/** Send a key combination (e.g., "C-c", "Enter") */
export function sendKey(t: TmuxHelper, key: string, sessionName = "e2e"): void {
  tmuxCmd(t, "send-keys", "-t", sessionName, key);
}

/** Capture the visible pane content as plain text */
export function capturePane(t: TmuxHelper, sessionName = "e2e"): string {
  return tmuxCmd(t, "capture-pane", "-t", sessionName, "-p");
}

/** Capture pane including scrollback history */
export function capturePaneHistory(t: TmuxHelper, sessionName = "e2e"): string {
  return tmuxCmd(t, "capture-pane", "-t", sessionName, "-p", "-S", "-1000");
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
    const content = capturePane(t, sessionName);
    if (content.includes(text)) {
      return content;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for text '${text}' in tmux session`);
}

/** Kill a tmux session */
export function killSession(t: TmuxHelper, sessionName = "e2e"): void {
  try {
    tmuxCmd(t, "kill-session", "-t", sessionName);
  } catch {
    // Ignore
  }
}
