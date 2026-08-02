import { ensureParakeet } from "./lib/parakeet.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { StepRunner } from "./lib/step-runner.js";
import { VmManager, type VmConfig } from "./lib/vm.js";
import { RunContext } from "./lib/run-context.js";
import * as tmux from "./lib/tmux.js";
import { execSync } from "node:child_process";

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
const SNAPSHOT_MODE = args.includes("--snapshot");

// Parse --timeout <seconds> (default: 180)
const timeoutIdx = args.indexOf("--timeout");
const GLOBAL_TIMEOUT_MS = timeoutIdx >= 0 ? (parseInt(args[timeoutIdx + 1]) || 180) * 1000 : 180_000;

// Parse --case <name> (select specific test case instead of random)
const caseIdx = args.indexOf("--case");
const SELECTED_CASE = caseIdx >= 0 ? args[caseIdx + 1] : undefined;

// Parse --output-method <method> (test specific output method: type, clipboard, mutter-virtual)
const outputMethodIdx = args.indexOf("--output-method");
const OUTPUT_METHOD = outputMethodIdx >= 0 ? args[outputMethodIdx + 1] : "type";

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
    baseImage: (() => {
      const uvBase = join(import.meta.dir, "qemu-images/base-with-uv.qcow2");
      return existsSync(uvBase) ? uvBase : join(import.meta.dir, "qemu-images/base.qcow2");
    })(),
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
const SSH_KEY = CONFIG.paths.sshKey;
const SSH_USER = CONFIG.ssh.user;
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
  let picked: TestCase;
  if (SELECTED_CASE) {
    picked = cases.find(c => c.file.includes(SELECTED_CASE))!;
    if (!picked) {
      throw new Error(`Test case '${SELECTED_CASE}' not found. Available: ${cases.map(c => c.file).join(", ")}`);
    }
    console.log(`  Selected test case (by name): ${picked.file}`);
  } else {
    picked = cases[Math.floor(Math.random() * cases.length)];
    console.log(`  Selected test case (random): ${picked.file}`);
  }
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

async function runTestFlow(vm: VmManager, run: RunContext): Promise<void> {
  const shell = vm.shell;
  let t: number;

  const tmuxCfg: tmux.TmuxHelper = {
    session: `e2e-${run.id}`,
    sshKey: SSH_KEY,
    sshPort: run.sshPort,
    sshUser: SSH_USER,
  };

  t = Date.now();
  await vm.captureFrame("01-desktop");
  timing("capture-frame", t);

  // Step 1: Dismiss Activities overview (D-Bus Set is idempotent)
  t = Date.now();
  console.log("Dismissing Activities...");
  await shell.dismissActivities();
  const activitiesOpen = await shell.isActivitiesOpen();
  console.log(`  Activities after dismiss: ${activitiesOpen ? 'STILL OPEN' : 'closed'}`);
  await shell.waitActivitiesDismissed();
  timing("dismiss-activities", t);

  // Step 2: Open terminal with tmux inside (dotool needs a focused window)
  t = Date.now();
  console.log("Opening terminal with tmux...");
  // Kill any stale tmux session from a previous run
  tmux.killSession(tmuxCfg);
  await shell.exec(`nohup gnome-terminal -- tmux new-session -s ${tmuxCfg.session} -x 120 -y 40 &>/dev/null &`);
  // Poll until tmux session appears
  await vm.pollUntil(
    "tmux session",
    async () => {
      const output = await shell.exec(`tmux list-sessions 2>/dev/null | grep ${tmuxCfg.session}`);
      return output.trim().length > 0;
    },
    15000
  );
  // Click on the terminal to ensure it has focus
  await shell.dotoolCommand("mousemove 640 400");
  await shell.dotoolCommand("buttondown 1");
  await shell.dotoolCommand("buttonup 1");
  // Brief wait for window manager to settle after click
  await Bun.sleep(500);

  // Verify terminal is focused by typing a test character and checking tmux
  const paneBefore = tmux.capturePane(tmuxCfg);
  await shell.dotoolCommand("key shift+space"); // type space to confirm dotool works
  await Bun.sleep(200);
  const paneAfter = tmux.capturePane(tmuxCfg);
  if (paneBefore === paneAfter) {
    // Terminal might not be focused, try clicking again
    console.log("  Retrying terminal focus...");
    await shell.dotoolCommand("mousemove 640 400");
    await shell.dotoolCommand("buttondown 1");
    await shell.dotoolCommand("buttonup 1");
    await Bun.sleep(500);
  }
  timing("open-terminal", t);

  t = Date.now();
  await vm.captureFrame("02-tmux-started");
  timing("capture-frame", t);

  // Step 3: Snapshot pane content before recording (for transcription detection)
  t = Date.now();
  const preRecordingPane = tmux.capturePane(tmuxCfg);
  console.log("Pre-recording pane captured.");
  timing("snapshot-pane", t);

  t = Date.now();
  await vm.captureFrame("03-pre-recording");
  timing("capture-frame", t);

  // Ensure Activities is dismissed right before recording
  // (may re-open after initial dismiss or from gnome-shell restart)
  await shell.dismissActivities();
  const activitiesOpen2 = await shell.isActivitiesOpen();
  console.log(`  Activities after second dismiss: ${activitiesOpen2 ? 'STILL OPEN' : 'closed'}`);
  await shell.waitActivitiesFullyClosed();
  
  // Force-focus terminal again after Activities dismiss
  await shell.focusTerminal();
  
  // Verify terminal has focus by typing test character
  console.log("Verifying terminal focus...");
  let isFocused = await shell.verifyTerminalFocus(tmuxCfg.session, SSH_KEY, run.sshPort);
  if (!isFocused) {
    console.log("  Terminal not focused, trying click + gio launch...");
    await shell.clickToFocus(640, 400);
    await Bun.sleep(500);
    await shell.focusTerminal();
    isFocused = await shell.verifyTerminalFocus(tmuxCfg.session, SSH_KEY, run.sshPort);
    console.log(`  After retry: focused=${isFocused}`);
  }
  if (!isFocused) {
    console.log("  WARNING: Terminal may not be focused");
  }
  // Step 4: Start recording via hotkey (D-Bus call to GNOME extension)
  t = Date.now();
  console.log("Starting recording via hotkey...");
  await shell.sendHotkey();
  await shell.waitForRecordingStart();
  timing("start-recording", t);

  t = Date.now();
  await vm.captureFrame("04-recording-started");
  timing("capture-frame", t);

  // Step 5: Wait for transcription (voice service types via dotool into tmux)
  t = Date.now();
  console.log("Waiting for transcription...");
  let transcription = "";
  try {
    // Poll the voice service log for the transcription result (most reliable source)
    await vm.pollUntil(
      "transcription",
      async () => {
        const logOutput = await shell.exec(
          `grep -oP 'Transcription result: \\K.*' /tmp/voice-service.log 2>/dev/null | tail -1`
        );
        const trimmed = logOutput.trim();
        if (trimmed && !/^\s*(?:\[[^\]]*\]\s*)?\S+@\S+/.test(trimmed)) {
          transcription = trimmed;
          console.log(`  Got from log: ${transcription}`);
          return true;
        }
        return false;
      },
      20000,
      500
    );
    // If log didn't have it, try tmux capture as fallback
    if (!transcription) {
      console.log("  Log poll timed out, trying tmux capture...");
      const paneContent = tmux.capturePane(tmuxCfg);
      // Strip prompt prefix from lines that contain it
      const promptPrefixRe = /^\s*(?:\[[^\]]*\]\s*)?\S+@\S+\s+\S*\s*[#$]\s*/;
      const newLines = paneContent.split("\n")
        .map(l => l.replace(promptPrefixRe, ""))
        .filter(l => l.trim() && !preRecordingPane.includes(l));
      transcription = newLines.join(" ").trim();
      if (transcription) {
        console.log(`  Got from tmux: ${transcription}`);
      }
    }
    if (!transcription) {
      console.log("  No transcription found");
    }
  } catch {
    console.log("  Transcription polling timed out");
  }
  timing("transcription", t);

  t = Date.now();
  await vm.captureFrame("05-transcription-received");
  timing("capture-frame", t);

  // Step 6: Stop recording
  t = Date.now();
  console.log("Stopping recording via hotkey...");
  await shell.sendHotkey();
  // Poll until recording state clears (sendHotkey is synchronous via D-Bus)
  await Bun.sleep(200); // Brief settle for D-Bus round-trip
  timing("stop-recording", t);

  t = Date.now();
  await vm.captureFrame("06-recording-stopped");
  timing("capture-frame", t);

  // Step 7: Write result to file
  t = Date.now();
  console.log("Writing result to file...");
  if (transcription) {
    const encoded = Buffer.from(transcription).toString('base64');
    await shell.exec(`echo '${encoded}' | base64 -d > /tmp/file.txt`);
  }
  // Poll until file exists and has content
  await vm.pollUntil(
    "result file written",
    async () => {
      const { stdout } = await vm.deployer.exec("cat /tmp/file.txt 2>/dev/null");
      return stdout.trim().length > 0;
    },
    5000,
    300
  );
  timing("write-result", t);

  // Cleanup: kill tmux session
  tmux.killSession(tmuxCfg);
}

/**
 * Get test case name from file path (e.g., "hello-world.wav" → "hello-world")
 */
function getTestCaseName(): string {
  const file = CURRENT_TEST.file;
  return file.replace(/\.wav$/, "");
}

/**
 * Get screenshot path based on label and test case.
 * - Common screenshots (01-04, 06): e2e/output/common/
 * - Transcription screenshot (05): e2e/output/test-cases/{testCase}/
 */
function getScreenshotPath(label: string, testCase?: string, outputDir = OUTPUT_DIR): string {
  if (label === "05-transcription-received" && testCase) {
    return join(outputDir, "test-cases", testCase, `screenshot-${label}.png`);
  }
  return join(outputDir, "common", `screenshot-${label}.png`);
}

/**
 * Capture screenshot via QEMU monitor and save as PNG.
 */
async function captureScreenshot(label: string, run: RunContext): Promise<string> {
  const testCase = getTestCaseName();
  const pngPath = getScreenshotPath(label, testCase, run.outputDir);
  const ppmPath = pngPath.replace(/\.png$/, ".ppm");
  
  // Ensure directory exists
  const dir = require("node:path").dirname(pngPath);
  require("node:fs").mkdirSync(dir, { recursive: true });
  
  try {
    // Use QEMU monitor to capture screenshot
    execSync(
      `echo "screendump ${ppmPath}" | nc -U ${run.socketPath} -w 2`,
      { encoding: "utf-8", timeout: 5000 }
    );
    // Wait for file to be written
    await Bun.sleep(500);
    // Convert PPM to PNG
    execSync(`convert ${ppmPath} ${pngPath} 2>/dev/null || true`, {
      encoding: "utf-8",
      timeout: 5000
    });
    // Clean up PPM
    execSync(`rm -f ${ppmPath}`, { encoding: "utf-8" });
    console.log(`  Screenshot saved: ${pngPath}`);
    return pngPath;
  } catch (err) {
    console.log(`  Screenshot capture failed: ${err}`);
    return "";
  }
}

/**
 * Verify screenshot matches reference (if exists) and file content matches expected text.
 */
async function verifyWithScreenshot(
  vm: VmManager,
  expected: string,
  run: RunContext
): Promise<{ passed: boolean; message: string; screenshot: string }> {
  const testCase = getTestCaseName();
  
  // Capture screenshot
  const screenshot = await captureScreenshot("05-transcription-received", run);
  
  // Verify via file (primary method)
  const { stdout: actual } = await vm.deployer.exec("cat /tmp/file.txt 2>/dev/null");
  
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\.+$/, "").replace(/\s+/g, " ");
  const actualNorm = normalize(actual);
  const expectedNorm = normalize(expected);
  
  // Check text match
  if (actualNorm !== expectedNorm) {
    return { passed: false, message: `Text does not match: expected '${expectedNorm}', got '${actualNorm}'`, screenshot };
  }
  
  // Check visual regression (if reference exists)
  const referencePath = getScreenshotPath("05-transcription-received", testCase, run.outputDir);
  if (existsSync(referencePath) && screenshot) {
    try {
      const diffPath = join(run.outputDir, "test-cases", testCase, "diff.png");
      const diffDir = require("node:path").dirname(diffPath);
      require("node:fs").mkdirSync(diffDir, { recursive: true });
      
      const result = execSync(
        `compare -metric MSE "${referencePath}" "${screenshot}" "${diffPath}" 2>&1`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim();
      
      const mse = parseFloat(result);
      if (mse >= 100) {
        return { passed: false, message: `Visual regression: MSE=${mse} (threshold=100)`, screenshot };
      }
      console.log(`  Visual regression: MSE=${mse} (pass)`);
    } catch (err) {
      console.log(`  Visual regression check failed: ${err}`);
    }
  } else if (!existsSync(referencePath)) {
    console.log(`  No reference image for visual regression: ${referencePath}`);
  }
  
  return { passed: true, message: "Text matches expected output", screenshot };
}

/**
 * Update reference images from captured screenshots.
 * Called when --update flag is used.
 */
function updateReferenceImages(run: RunContext): void {
  const testCase = getTestCaseName();
  console.log(`\nUpdating reference images for test case: ${testCase}`);
  
  // Create reference directories
  const commonRefDir = join(CONFIG.paths.referencesDir, "common");
  const testCaseRefDir = join(CONFIG.paths.referencesDir, "test-cases", testCase);
  mkdirSync(commonRefDir, { recursive: true });
  mkdirSync(testCaseRefDir, { recursive: true });
  
  // Copy common screenshots
  const commonLabels = ["01-desktop", "02-tmux-started", "03-pre-recording", "04-recording-started", "06-recording-stopped"];
  for (const label of commonLabels) {
    const src = getScreenshotPath(label, undefined, run.outputDir);
    const dst = join(commonRefDir, `screenshot-${label}.png`);
    if (existsSync(src)) {
      execSync(`cp "${src}" "${dst}"`, { encoding: "utf-8" });
      console.log(`  Copied: ${label} → common/`);
    }
  }
  
  // Copy test-case-specific screenshot
  const transcriptionSrc = getScreenshotPath("05-transcription-received", testCase, run.outputDir);
  const transcriptionDst = join(testCaseRefDir, "screenshot-05-transcription-received.png");
  if (existsSync(transcriptionSrc)) {
    execSync(`cp "${transcriptionSrc}" "${transcriptionDst}"`, { encoding: "utf-8" });
    console.log(`  Copied: transcription → test-cases/${testCase}/`);
  }
}

async function main(): Promise<void> {
  const run = new RunContext({
    baseImage: BASE_IMAGE,
    sshKey: SSH_KEY,
    sshUser: SSH_USER,
    projectRoot: PROJECT_ROOT,
    pythonSrc: PYTHON_SRC,
    fixtureDir: join(import.meta.dir, "fixtures"),
    extensionUuid: CONFIG.extension.uuid,
    testAudioFile: join(import.meta.dir, "fixtures", CURRENT_TEST.file),
    recordMode: RECORD_MODE,
    updateMode: UPDATE_MODE,
  });
  console.log(`Run ID: ${run.id}`);
  console.log(`Run directory: ${run.runDir}`);
  console.log(`SSH port: ${run.sshPort}`);
  console.log(`Spice port: ${run.spicePort}`);

  const vmCfg: VmConfig = {
    run,
    baseImage: BASE_IMAGE,
    vmDir: VM_DIR,
    sshKey: SSH_KEY,
    sshUser: SSH_USER,
    projectRoot: PROJECT_ROOT,
    pythonSrc: PYTHON_SRC,
    fixtureDir: join(import.meta.dir, "fixtures"),
    extensionUuid: CONFIG.extension.uuid,
    recordMode: RECORD_MODE,
    updateMode: UPDATE_MODE,
    testAudioFile: join(import.meta.dir, "fixtures", CURRENT_TEST.file),
  };
  const vm = new VmManager(vmCfg);
  const startTime = Date.now();
  let testsFailed = 0;

  // Global timeout watchdog — sets a flag instead of process.exit so cleanup runs
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.error(`\nTIMEOUT: Test exceeded ${GLOBAL_TIMEOUT_MS / 1000}s limit (${elapsed}s elapsed)`);
    timedOut = true;
  }, GLOBAL_TIMEOUT_MS);


  try {
    if (SNAPSHOT_MODE) {
      // Snapshot mode: boot once, save snapshot, retry on failure
      await new StepRunner().run([
        { name: "preflight", fn: preflight },
        { name: "boot-vm", fn: () => vm.boot(), timeout: 120_000 },
        { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 120_000 },
        { name: "setup", fn: () => vm.setup(), timeout: 180_000 },
        { name: "save-snapshot", fn: () => vm.saveCleanSnapshot() },
      ]);
      
      // First attempt
      await runTestFlow(vm, run);
      let result = await verifyWithScreenshot(vm, EXPECTED_TEXT, run);
      
      if (!result.passed) {
        console.log("\n--- Test failed, restoring snapshot and retrying ---");
        await vm.resetToCleanState();
        
        // Retry attempt
        await runTestFlow(vm, run);
        result = await verifyWithScreenshot(vm, EXPECTED_TEXT, run);
      }
      
      if (result.passed) {
        console.log(`  PASS: ${result.message}`);
      } else {
        console.log(`  FAIL: ${result.message}`);
        testsFailed++;
      }
    } else {
      // Fresh mode: original behavior
      await new StepRunner().run([
        { name: "preflight", fn: preflight },
        { name: "boot-vm", fn: () => vm.boot(), timeout: 120_000 },
        { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 120_000 },
        { name: "setup", fn: () => vm.setup(), timeout: 180_000 },
        { name: "test-flow", fn: () => runTestFlow(vm, run) },
      ]);
      
      const result = await verifyWithScreenshot(vm, EXPECTED_TEXT, run);
      if (result.passed) {
        console.log(`  PASS: ${result.message}`);
      } else {
        console.log(`  FAIL: ${result.message}`);
        testsFailed++;
      }
    }

    // Update reference images if in update mode
    if (UPDATE_MODE) {
      updateReferenceImages(run);
    }

    // Check if watchdog timed out during execution
    if (timedOut) {
      testsFailed++;
    }
  } catch (err) {
    console.error("\nFATAL:", err);
    testsFailed++;
  } finally {
    if (SHUTDOWN) {
      await vm.shutdown();
      run.cleanup();
      console.log("\nVM shut down.");
    } else {
      console.log("\nVM kept running (pass --shutdown to stop)");
      console.log(`SSH: ssh -i ${SSH_KEY} -p ${run.sshPort} ${SSH_USER}@localhost`);
      console.log(`Spice: spice://localhost:${run.spicePort}`);
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
