/**
 * Helper class for transcription-related operations.
 */

import { timing } from "./utils.js";

/**
 * Decorator that times async method calls.
 */
function timed(label: string) {
  return function (target: any, context: ClassMethodDecoratorContext) {
    return async function (this: any, ...args: any[]) {
      const start = Date.now();
      try {
        return await target.call(this, ...args);
      } finally {
        timing(label, start);
      }
    };
  };
}

export class TranscriptionHelper {
  /**
   * Wait for transcription to appear in the voice service log.
   * Uses tail -f to watch for new lines, with a 20s timeout.
   */
  @timed("wait:transcription-log")
  async waitForTranscriptionFromLog(shell: any): Promise<string> {
    return shell.exec(
      `timeout 20 tail -f -n +1 /tmp/voice-service.log 2>/dev/null | grep --line-buffered -oP 'Transcription result: \\K.*' | head -1`,
      25000 // slightly more than the 20s timeout in the command
    );
  }
}
