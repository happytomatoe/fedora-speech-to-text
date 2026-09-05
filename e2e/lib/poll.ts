import { existsSync, statSync } from "node:fs";

/** Poll until `check()` returns true, or throw after timeoutMs. */
export async function pollUntil(
  desc: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100
): Promise<void> {
  const start = Date.now();
  const quiet = !!process.env.TIMING_MODE;
  if (!quiet) process.stdout.write(`Waiting for ${desc}`);

  try {
    while (Date.now() - start < timeoutMs) {
      if (await check()) {
        console.log(`${quiet ? "  " : " "}ready (${Math.round((Date.now() - start) / 1000)}s)`);
        return;
      }
      if (!quiet) process.stdout.write(".");
      await Bun.sleep(intervalMs);
    }

    console.log(` TIMEOUT after ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(`Timeout waiting for ${desc}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Timeout")) throw err;
    if (!quiet) process.stdout.write("\n");
    throw err;
  }
}

/** Poll until a local file exists and is non-empty, or throw after timeoutMs. */
export async function pollFileExists(path: string, timeoutMs = 2000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (!existsSync(path) || statSync(path).size === 0) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for file: ${path}`);
    await Bun.sleep(intervalMs);
  }
}

/** Poll via `shellExec` until the given process name is gone. */
export async function pollForProcess(
  shellExec: (cmd: string) => Promise<string>,
  processName: string,
  timeoutMs = 10000
): Promise<void> {
  await pollUntil(
    `${processName} running`,
    async () => {
      try {
        const output = await shellExec(`pgrep -f '${processName}'`);
        return output.trim().length > 0;
      } catch (err) {
        console.warn(`[poll] pgrep failed (still waiting): ${err instanceof Error ? err.message : err}`);
        return false;
      }
    },
    timeoutMs
  );
}

/** Poll via `shellExec` until the command output contains `expected`. */
export async function pollForCommandOutput(
  shellExec: (cmd: string) => Promise<string>,
  command: string,
  expected: string,
  timeoutMs = 10000
): Promise<void> {
  await pollUntil(
    `command output contains '${expected}'`,
    async () => {
      try {
        const output = await shellExec(command);
        return output.includes(expected);
      } catch (err) {
        console.warn(`[poll] command failed (still waiting): ${err instanceof Error ? err.message : err}`);
        return false;
      }
    },
    timeoutMs
  );
}
