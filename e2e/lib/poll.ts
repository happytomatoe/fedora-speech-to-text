export async function pollUntil(
  desc: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 1000
): Promise<void> {
  const start = Date.now();
  process.stdout.write(`Waiting for ${desc}`);

  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      console.log(` ready (${Math.round((Date.now() - start) / 1000)}s)`);
      return;
    }
    process.stdout.write(".");
    await Bun.sleep(intervalMs);
  }

  console.log(` TIMEOUT after ${Math.round(timeoutMs / 1000)}s`);
  throw new Error(`Timeout waiting for ${desc}`);
}

export async function pollForProcess(
  shellExec: (cmd: string) => Promise<string>,
  processName: string,
  timeoutMs = 10000
): Promise<void> {
  await pollUntil(
    `${processName} running`,
    async () => {
      const output = await shellExec(`pgrep -f '${processName}'`);
      return output.trim().length > 0;
    },
    timeoutMs
  );
}

export async function pollForCommandOutput(
  shellExec: (cmd: string) => Promise<string>,
  command: string,
  expected: string,
  timeoutMs = 10000
): Promise<void> {
  await pollUntil(
    `command output contains '${expected}'`,
    async () => {
      const output = await shellExec(command);
      return output.includes(expected);
    },
    timeoutMs
  );
}
