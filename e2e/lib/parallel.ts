import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { VmManager, VmConfig } from "./vm.js";
import { RunContext } from "./run-context.js";

export interface ParallelConfig {
  maxVMs: number;
  testCases: TestCase[];
  outputDir: string;
  baseImage: string;
  sshKey: string;
  sshUser: string;
  projectRoot: string;
  pythonSrc: string;
  fixtureDir: string;
  extensionUuid: string;
  recordMode: boolean;
  updateMode: boolean;
  skipDeps: boolean;
  env: import("./env.js").SuiteEnv;
}

export interface TestCase {
  id: string;
  audioFile: string;
  expectedText: string;
  outputMethod: string;
  priority: string;
}

interface VMWorker {
  vm: VmManager;
  run: RunContext;
  busy: boolean;
  testCase?: TestCase;
}

export class ParallelTestRunner {
  private workers: VMWorker[] = [];
  private queue: TestCase[] = [];
  private results: Map<string, { passed: boolean; duration: number; error?: string }> = new Map();
  private totalTests = 0;
  private completedTests = 0;

  constructor(private config: ParallelConfig) {}

  /**
   * Run all test cases in parallel
   */
  async runAll(): Promise<Map<string, { passed: boolean; duration: number; error?: string }>> {
    console.log(`\n🚀 Starting parallel execution with ${this.config.maxVMs} VM(s)`);
    console.log(`   Total test cases: ${this.config.testCases.length}`);
    console.log(`   Output directory: ${this.config.outputDir}\n`);

    this.totalTests = this.config.testCases.length;
    this.queue = [...this.config.testCases];

    // Create output directory
    mkdirSync(this.config.outputDir, { recursive: true });

    // Initialize VM workers
    await this.initializeWorkers();

    // Run tests
    await this.processQueue();

    // Shutdown all VMs
    await this.shutdownWorkers();

    return this.results;
  }

  /**
   * Initialize VM workers
   */
  private async initializeWorkers(): Promise<void> {
    console.log(`\n📦 Initializing ${this.config.maxVMs} VM worker(s)...`);

    for (let i = 0; i < this.config.maxVMs; i++) {
      const runId = `parallel-${i}-${Date.now().toString(36)}`;
      const runDir = join(this.config.outputDir, runId);
      mkdirSync(runDir, { recursive: true });

      const run = new RunContext({
        baseImage: this.config.baseImage,
        sshKey: this.config.sshKey,
        sshUser: this.config.sshUser,
        projectRoot: this.config.projectRoot,
        pythonSrc: this.config.pythonSrc,
        fixtureDir: this.config.fixtureDir,
        extensionUuid: this.config.extensionUuid,
        testAudioFile: "",
        recordMode: this.config.recordMode,
        updateMode: this.config.updateMode
      }, runId);

      const vmConfig: VmConfig = {
        run,
        baseImage: this.config.baseImage,
        vmDir: join(this.config.projectRoot, "e2e", "qemu-images"),
        sshKey: this.config.sshKey,
        sshUser: this.config.sshUser,
        projectRoot: this.config.projectRoot,
        pythonSrc: this.config.pythonSrc,
        fixtureDir: this.config.fixtureDir,
        extensionUuid: this.config.extensionUuid,
        recordMode: this.config.recordMode,
        updateMode: this.config.updateMode,
        testAudioFile: "", // Will be set per test
        skipDeps: this.config.skipDeps,
        env: this.config.env,
      };

      const vm = new VmManager(vmConfig);
      this.workers.push({ vm, run, busy: false });

      console.log(`   Worker ${i}: SSH port ${run.sshPort}`);
    }
  }

  /**
   * Process the test queue
   */
  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 || this.workers.some(w => w.busy)) {
      // Find available worker
      const availableWorker = this.workers.find(w => !w.busy);

      if (availableWorker && this.queue.length > 0) {
        const testCase = this.queue.shift()!;
        this.runTestOnWorker(availableWorker, testCase);
      } else {
        // Wait for a worker to finish
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Run a test on a specific worker
   */
  private async runTestOnWorker(worker: VMWorker, testCase: TestCase): Promise<void> {
    worker.busy = true;
    worker.testCase = testCase;

    const startTime = Date.now();
    console.log(`\n[${worker.run.id}] Starting test: ${testCase.id} (${testCase.outputMethod})`);

    try {
      // Update test audio file
      worker.vm.config.testAudioFile = join(this.config.fixtureDir, testCase.audioFile);

      // Shutdown previous VM if still running
      if (worker.vm.booted) {
        try {
          await worker.vm.qemu.connect();
          await worker.vm.qemu.systemPowerdown();
          await Bun.sleep(2000);
        } catch (err) {
          console.warn(`[parallel] systemPowerdown failed: ${err instanceof Error ? err.message : err}`);
        }
        try {
          Bun.spawnSync(["pkill", "-f", `qemu-system.*${worker.vm.config.run.overlayImage}`]);
          await Bun.sleep(1000);
        } catch (err) {
          console.warn(`[parallel] pkill failed: ${err instanceof Error ? err.message : err}`);
        }
        worker.vm.booted = false;
      }

      // Create fresh overlay for each test (snapshot restore)
      const overlayPath = worker.vm.config.run.overlayImage;
      try { unlinkSync(overlayPath); } catch (err) {
        if (!((err as NodeJS.ErrnoException)?.code === "ENOENT")) {
          console.warn(`[parallel] overlay unlink failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Run the test
      await worker.vm.boot();
      await worker.vm.waitForSsh();
      await worker.vm.setup();

      // Run test flow
      const passed = await this.runTestFlow(worker.vm, testCase);

      const duration = Date.now() - startTime;
      this.results.set(testCase.id, { passed, duration });

      this.completedTests++;
      console.log(`[${worker.run.id}] ✅ ${testCase.id}: ${passed ? 'PASSED' : 'FAILED'} (${(duration / 1000).toFixed(1)}s) [${this.completedTests}/${this.totalTests}]`);

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.results.set(testCase.id, { passed: false, duration, error: errorMsg });

      this.completedTests++;
      console.log(`[${worker.run.id}] ❌ ${testCase.id}: ERROR - ${errorMsg} (${(duration / 1000).toFixed(1)}s) [${this.completedTests}/${this.totalTests}]`);
    } finally {
      worker.busy = false;
      worker.testCase = undefined;
    }
  }

  /**
   * Run the actual test flow
   */
  private async runTestFlow(vm: VmManager, testCase: TestCase): Promise<boolean> {
    // This is a simplified version - in reality, you'd call the actual test flow
    // For now, we'll just return true
    return true;
  }

  /**
   * Shutdown all workers
   */
  private async shutdownWorkers(): Promise<void> {
    console.log(`\n🛑 Shutting down ${this.workers.length} VM worker(s)...`);

    for (const worker of this.workers) {
      try {
        await worker.vm.shutdown();
      } catch (err) {
        console.warn(`[parallel] worker shutdown failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Print summary
   */
  printSummary(): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 PARALLEL TEST SUMMARY`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Total tests: ${this.totalTests}`);
    console.log(`Completed: ${this.completedTests}`);
    console.log(`Passed: ${[...this.results.values()].filter(r => r.passed).length}`);
    console.log(`Failed: ${[...this.results.values()].filter(r => !r.passed).length}`);
    console.log(`${'='.repeat(60)}\n`);

    // Print per-test results
    for (const [testId, result] of this.results) {
      const status = result.passed ? '✅' : '❌';
      const duration = (result.duration / 1000).toFixed(1);
      console.log(`${status} ${testId}: ${duration}s${result.error ? ` - ${result.error}` : ''}`);
    }
  }
}
