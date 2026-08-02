export interface Step {
  name: string;
  fn: () => Promise<void>;
  timeout?: number;
}

export class StepRunner {
  async run(steps: Step[]): Promise<void> {
    for (const step of steps) {
      console.log(`[step] ${step.name}`);
      const start = Date.now();

      try {
        if (step.timeout) {
          let timer: ReturnType<typeof setTimeout>;
          await Promise.race([
            step.fn(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Step '${step.name}' timed out after ${step.timeout}ms`)), step.timeout!);
            }),
          ]).finally(() => clearTimeout(timer));
        } else {
          await step.fn();
        }
        const ms = Date.now() - start;
        console.log(`  ✓ ${step.name} [time] ${(ms / 1000).toFixed(1)}s`);
      } catch (err) {
        const ms = Date.now() - start;
        console.error(`  ✗ ${step.name} FAILED (${(ms / 1000).toFixed(1)}s):`, err);
        throw err;
      }
    }
  }
}
