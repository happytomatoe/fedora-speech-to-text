/**
 * Utility functions for E2E tests.
 */

/**
 * Print timing information for an operation.
 *
 * @param label - Description of the operation
 * @param startMs - Start time in milliseconds (from Date.now())
 */
export function timing(label: string, startMs: number): void {
  const ms = Date.now() - startMs;
  console.log(`  [time] ${label}: ${ms}ms`);
}

/**
 * Time an async operation and return its result.
 *
 * @param label - Description of the operation
 * @param fn - Async function to time
 * @returns The result of fn
 */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const result = await fn();
  timing(label, t);
  return result;
}

/**
 * Sleep with optional timing label.
 *
 * @param ms - Milliseconds to sleep
 * @param label - Optional label for timing output
 */
export async function timedSleep(ms: number, label?: string): Promise<void> {
  const t = Date.now();
  await Bun.sleep(ms);
  if (label) timing(label, t);
}
