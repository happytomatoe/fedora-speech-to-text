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
   * Polls the log file every 500ms for up to 25 seconds.
   * Uses deployer's SSH connection with simple grep command (no pipes).
   */
  @timed("wait:transcription-log")
  async waitForTranscriptionFromLog(deployer: any): Promise<string> {
    const startTime = Date.now();
    const timeoutMs = 25000;
    const pollIntervalMs = 500;
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        // Use deployer.exec() with simple command (no pipes to avoid connection issues)
        const result = await deployer.exec('grep -a "Transcription result:" /tmp/voice-service.log');
        
        if (result.code === 0 && result.stdout) {
          // Extract the transcription from the last matching line
          const lines = result.stdout.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          const match = lastLine.match(/Transcription result: (.*)/);
          if (match) {
            console.log(`  Found transcription: ${match[1]}`);
            return match[1];
          }
        }
      } catch {
        // Ignore errors (file might not exist yet)
      }
      
      // Wait before polling again
      await Bun.sleep(pollIntervalMs);
    }
    
    // Timeout reached - log debug info
    try {
      const debug = await deployer.exec('tail -5 /tmp/voice-service.log');
      console.log(`  Debug - last 5 lines of log:\n${debug.stdout}`);
    } catch {
      // Ignore
    }
    
    return "";
  }
}
