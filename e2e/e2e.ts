import { ensureParakeet, PORT as PARAKEET_PORT, ENDPOINT as PARAKEET_ENDPOINT } from "./lib/parakeet.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { StepRunner } from "./lib/step-runner.js";
import { VmManager, type VmConfig } from "./lib/vm.js";

// Log to file
const LOG_DIR = join(import.meta.dir, "output");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "e2e.log");
// Clear log file at start of run
writeFileSync(LOG_FILE, "");

const origLog = console.log;
const origError = console.error;
console.log = (...args: any[]) => {
  origLog(...args);
  appendFileSync(LOG_FILE, args.join(" ") + "\n");
};
console.error = (...args: any[]) => {
  origError(...args);
  appendFileSync(LOG_FILE, "ERROR: " + args.join(" ") + "\n");
};


// Parse CLI args
const args = process.argv.slice(2);
const UPDATE_MODE = args.includes("--update");
const SHUTDOWN = args.includes("--shutdown");
const NO_RECORD = args.includes("--no-record");
const RECORD_MODE = !NO_RECORD; // enabled by default
const TIMING_MODE = args.includes("--timing");

// Parse --timeout <seconds> (default: 60)
const timeoutIdx = args.indexOf("--timeout");
const GLOBAL_TIMEOUT_MS = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1]) * 1000 : 60_000;

function timing(label: string, startMs: number): void {
  if (TIMING_MODE) {
    const ms = Date.now() - startMs;
    console.log(`  [time] ${label}: ${ms}ms`);
  }
}

// Configuration
const CONFIG = {
  paths: {
    projectRoot: join(import.meta.dir, ".."),
    vmDir: join(import.meta.dir, "qemu-images"),
    baseImage: join(import.meta.dir, "qemu-images/base.qcow2"),
    overlayImage: join(import.meta.dir, "qemu-images/overlay.qcow2"),
    socketPath: "/tmp/qemu-monitor.sock",
    sshKey: join(import.meta.dir, "qemu-images/id_ed25519"),
    referencesDir: join(import.meta.dir, "expected-qemu"),
    outputDir: join(import.meta.dir, "output"),
    pythonSrc: join(import.meta.dir, "../src/voice_to_text"),
    testCasesFile: join(import.meta.dir, "fixtures/test-cases.json"),
  },
  ssh: {
    port: 2222,
    user: "testuser",
  },
  extension: {
    uuid: "voice-to-text@happytomatoe.com",
  },
  timeouts: {
    gdm: 60000,
    gnomeShell: 30000,
    dbus: 15000,
    dotool: 10000,
    vmBoot: 120000,
  },
};

// Derived constants
const PROJECT_ROOT = CONFIG.paths.projectRoot;
const VM_DIR = CONFIG.paths.vmDir;
const BASE_IMAGE = CONFIG.paths.baseImage;
const OVERLAY_IMAGE = CONFIG.paths.overlayImage;
const SOCKET_PATH = CONFIG.paths.socketPath;
const SSH_KEY = CONFIG.paths.sshKey;
const SSH_PORT = CONFIG.ssh.port;
const SSH_USER = CONFIG.ssh.user;
const REFERENCES_DIR = CONFIG.paths.referencesDir;
const OUTPUT_DIR = CONFIG.paths.outputDir;
const PYTHON_SRC = CONFIG.paths.pythonSrc;
const TEST_CASES_FILE = CONFIG.paths.testCasesFile;

interface TestCase {
  file: string;
  expected: string;
}

function pickRandomTestCase(): TestCase {
  const data = JSON.parse(readFileSync(TEST_CASES_FILE, "utf-8"));
  const cases: TestCase[] = data["test-cases"];
  const picked = cases[Math.floor(Math.random() * cases.length)];
  console.log(`  Selected test case: ${picked.file}`);
  return picked;
}

const CURRENT_TEST = pickRandomTestCase();
const EXPECTED_TEXT = CURRENT_TEST.expected;

async function preflight(): Promise<void> {
  if (!existsSync(BASE_IMAGE)) {
    throw new Error(`Base VM image not found: ${BASE_IMAGE}\nRun 'just qemu-e2e-setup' first.`);
  }

  if (!existsSync(SSH_KEY)) {
    throw new Error(`SSH key not found: ${SSH_KEY}\nRun 'just qemu-e2e-setup' first.`);
  }

  // Ensure Parakeet is available for local transcription
  await ensureParakeet();
}

async function runTestFlow(vm: VmManager): Promise<void> {
  const shell = vm.shell;
  let t: number;

  t = Date.now();
  await vm.captureFrame("01-desktop");
  timing("capture-frame", t);

  // Step 1: Dismiss Activities overview if open
  t = Date.now();
  console.log("Dismissing Activities...");
  await shell.dotoolCommand("key Escape");
  await Bun.sleep(1000);
  timing("dismiss-activities", t);

  // Step 2: Open terminal and wait for it to be ready
  t = Date.now();
  console.log("Opening terminal...");
  await shell.exec("nohup gnome-terminal &>/dev/null &");
  // Poll until terminal process appears
  await vm.pollUntil(
    "terminal",
    async () => {
      const output = await shell.exec("pgrep -x gnome-terminal");
      return output.trim().length > 0;
    },
    10000
  );
  // Click on the terminal to ensure it has focus
  await shell.dotoolCommand("mousemove 640 400");
  await Bun.sleep(200);
  await shell.dotoolCommand("buttondown 1");
  await Bun.sleep(100);
  await shell.dotoolCommand("buttonup 1");
  await Bun.sleep(1000);
  timing("open-terminal", t);

  t = Date.now();
  await vm.captureFrame("02-terminal-open");
  timing("capture-frame", t);

  // Step 3: Type echo command
  t = Date.now();
  console.log("Typing echo command...");
  await shell.dotoolCommand('type echo "');
  await Bun.sleep(1000);
  timing("type-echo", t);

  t = Date.now();
  await vm.captureFrame("03-echo-typed");
  timing("capture-frame", t);

  // Step 4: Start recording via hotkey
  t = Date.now();
  console.log("Starting recording via hotkey...");
  await shell.sendHotkey();
  await shell.waitForRecordingStart();
  timing("start-recording", t);

  t = Date.now();
  await vm.captureFrame("04-recording-started");
  timing("capture-frame", t);

  // Step 5: Wait for transcription
  t = Date.now();
  console.log("Waiting for transcription...");
  let transcription = "";
  try {
    transcription = await shell.waitForTranscription(30000);
    console.log(`  Got: ${transcription}`);
  } catch {
    console.log("  TIMEOUT - continuing anyway");
  }
  timing("transcription", t);

  t = Date.now();
  await vm.captureFrame("05-transcription-received");
  timing("capture-frame", t);

  // Step 6: Stop recording
  t = Date.now();
  console.log("Stopping recording via hotkey...");
  await shell.sendHotkey();
  await Bun.sleep(500); // Brief pause for hotkey processing
  timing("stop-recording", t);

  t = Date.now();
  await vm.captureFrame("06-recording-stopped");
  timing("capture-frame", t);

  // Step 7: Write result to file
  t = Date.now();
  console.log("Writing result to file...");
  if (transcription) {
    // Base64 encode to avoid shell injection from apostrophes in speech
    const encoded = Buffer.from(transcription).toString('base64');
    await shell.exec(`echo '${encoded}' | base64 -d > /tmp/file.txt`);
  }
  await Bun.sleep(1000);
  timing("write-result", t);
}

async function verifyResult(vm: VmManager): Promise<{ passed: boolean; message: string }> {
  console.log("\n=== Verification ===");

  const expected = EXPECTED_TEXT;
  const { stdout: actual } = await vm.deployer.exec("cat /tmp/file.txt 2>/dev/null");

  console.log(`  Expected: ${expected}`);
  console.log(`  Actual:   ${actual.trim()}`);

  // Normalize: lowercase, strip trailing period, collapse whitespace
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\.+$/, "").replace(/\s+/g, " ");
  const actualNorm = normalize(actual);
  const expectedNorm = normalize(expected);
  console.log(`  Normalized expected: ${expectedNorm}`);
  console.log(`  Normalized actual:   ${actualNorm}`);
  if (actualNorm === expectedNorm) {
    return { passed: true, message: "Text matches expected output" };
  }
  return { passed: false, message: `Text does not match: expected '${expectedNorm}', got '${actualNorm}'` };
}

async function main(): Promise<void> {
  const vmCfg: VmConfig = {
    socketPath: SOCKET_PATH,
    baseImage: BASE_IMAGE,
    overlayImage: OVERLAY_IMAGE,
    vmDir: VM_DIR,
    sshKey: SSH_KEY,
    sshPort: SSH_PORT,
    sshUser: SSH_USER,
    projectRoot: PROJECT_ROOT,
    pythonSrc: PYTHON_SRC,
    fixtureDir: join(import.meta.dir, "fixtures"),
    outputDir: OUTPUT_DIR,
    extensionUuid: CONFIG.extension.uuid,
    recordMode: RECORD_MODE,
    updateMode: UPDATE_MODE,
  };
  const vm = new VmManager(vmCfg);
  const startTime = Date.now();
  let testsFailed = 0;

  // Global timeout watchdog
  const timeoutTimer = setTimeout(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.error(`\nTIMEOUT: Test exceeded ${GLOBAL_TIMEOUT_MS / 1000}s limit (${elapsed}s elapsed)`);
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);


  try {
    await new StepRunner().run([
      { name: "preflight", fn: preflight },
      { name: "boot-vm", fn: () => vm.boot(), timeout: 120_000 },
      { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 120_000 },
      { name: "setup", fn: () => vm.setup(), timeout: 180_000 },
      { name: "test-flow", fn: () => runTestFlow(vm) },
    ]);

    // Verify
    const result = await verifyResult(vm);
    if (result.passed) {
      console.log(`  PASS: ${result.message}`);
    } else {
      console.log(`  FAIL: ${result.message}`);
      testsFailed++;
    }
  } catch (err) {
    console.error("\nFATAL:", err);
    testsFailed++;
  } finally {
    if (SHUTDOWN) {
      await vm.shutdown();
    } else {
      console.log("\nVM kept running (default; pass --shutdown to stop)");
      console.log(`SSH: ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@localhost`);
    }
  }

  // Timing summary
  const elapsed = Date.now() - startTime;
  console.log("\n=== Timing Summary ===");
  console.log(`  Total: ${(elapsed / 1000).toFixed(1)}s`);
  console.log("");

  // Clear the timeout timer
  clearTimeout(timeoutTimer);

  if (testsFailed === 0) {
    console.log("All tests passed!");
    process.exit(0);
  } else {
    console.log(`${testsFailed} test(s) failed.`);
    process.exit(1);
}
}

main();
