import { ensureParakeet } from "./lib/parakeet.js";
import { ParallelTestRunner, type TestCase } from "./lib/parallel.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { StepRunner } from "./lib/step-runner.js";
import { VmManager, type VmConfig } from "./lib/vm.js";
import { RunContext } from "./lib/run-context.js";
import { deployTestAudio, deployExtension, startVoiceService } from "./lib/deploy-steps.js";
import { pollForCommandOutput } from "./lib/poll.js";
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

// In timing mode, only show timing-related output on stdout.
// Everything still goes to the log file.
function isTimingOutput(msg: string): boolean {
  return msg.includes("[time]") || msg.includes("Total:") || msg.includes("=== Timing");
}

console.log = (...args: any[]) => {
  const msg = args.join(" ");
  appendFileSync(LOG_FILE, msg + "\n");
  if (!TIMING_MODE || isTimingOutput(msg)) {
    origLog(...args);
  }
};
console.error = (...args: any[]) => {
  const msg = args.join(" ");
  appendFileSync(LOG_FILE, "ERROR: " + msg + "\n");
  origError(...args);
};


// Parse CLI args
const args = process.argv.slice(2);
const UPDATE_MODE = args.includes("--update");
// Default: shut the VM down after the test (pass/fail). Keep it running for
// manual debugging with --keep-vm.
const KEEP_VM = args.includes("--keep-vm");
const NO_RECORD = args.includes("--no-record");
const RECORD_MODE = !NO_RECORD; // enabled by default
const TIMING_MODE = args.includes("--timing");
if (TIMING_MODE) process.env.TIMING_MODE = "1";

// VM shutdown kills the ssh2 Deployer socket mid-connection, which can emit a
// late ECONNRESET/EPIPE after all tests have finished. Swallow them so
// teardown noise can't crash the process or flip the exit code.
const isTeardownSocketError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException)?.code ?? "";
  const msg = err instanceof Error ? err.message : String(err);
  return code === "ECONNRESET" || code === "EPIPE" || msg.includes("ECONNRESET") || msg.includes("EPIPE");
};
process.on("uncaughtException", (err) => {
  if (isTeardownSocketError(err)) {
    console.log(`Ignoring late socket error during teardown (${(err as NodeJS.ErrnoException).code})`);
    return;
  }
  console.error("Uncaught exception:", err);
  process.exitCode = 1;
});
process.on("unhandledRejection", (err) => {
  if (isTeardownSocketError(err)) {
    console.log(`Ignoring late socket error rejection during teardown (${(err as NodeJS.ErrnoException).code})`);
    return;
  }
  console.error("Unhandled rejection:", err);
  process.exitCode = 1;
});
// Snapshots: savevm previously failed with the GL display
// (-device virtio-vga-gl -display gtk,gl=on). Display is now non-GL, so
// snapshot mode can be re-enabled by flipping this to !NO_SNAPSHOT once
// savevm/loadvm are verified against the current display config.
const NO_SNAPSHOT = args.includes("--no-snapshot");
// --no-save-snapshot: restore an existing snapshot but never save/update it
// (default for routine runs — snapshot saving is opt-in via --save-snapshot).
const NO_SAVE_SNAPSHOT = args.includes("--no-save-snapshot") || !args.includes("--save-snapshot");
// ponytail: snapshots disabled pending savevm/loadvm verification on non-GL display — flip to !NO_SNAPSHOT after verifying, remove stale comment
const SNAPSHOT_MODE = !NO_SNAPSHOT; // TEMP: Phase 1 verification of savevm/loadvm on non-GL gtk display — revert or replace with !NO_SNAPSHOT after verifying (plan: thoughts/shared/plans/re-enable-e2e-snapshots.md)
const SKIP_DEPS = args.includes("--skip-deps");

// Parse --timeout <seconds> (default: 180)
const timeoutIdx = args.indexOf("--timeout");
const GLOBAL_TIMEOUT_MS = timeoutIdx >= 0 ? (parseInt(args[timeoutIdx + 1]) || 600) * 1000 : 600_000;

// Parse --case <name> (select specific test case instead of random)
const caseIdx = args.indexOf("--case");
const SELECTED_CASE = caseIdx >= 0 ? args[caseIdx + 1] : undefined;

// Parse --output-method <method> (test specific output method: type, clipboard, mutter-virtual)
const outputMethodIdx = args.indexOf("--output-method");
const OUTPUT_METHOD = outputMethodIdx >= 0 ? args[outputMethodIdx + 1] : "type";

// Parse --parallel <n> (run n VMs in parallel)
const parallelIdx = args.indexOf("--parallel");
const PARALLEL_VMS = parallelIdx >= 0 ? parseInt(args[parallelIdx + 1]) || 1 : 1;

// Parse --test-prefs (run preferences screenshot tests)
const TEST_PREFS = args.includes("--test-prefs");

function timing(label: string, startMs: number): void {
  const ms = Date.now() - startMs;
  console.log(`  [time] ${label}: ${ms}ms`);
}

// Configuration
const CONFIG = {
  paths: {
    projectRoot: join(import.meta.dir, ".."),
    vmDir: join(import.meta.dir, "qemu-images"),
    baseImage: (() => {
      const goldenDeps = join(import.meta.dir, "qemu-images/golden-gnome-deps.qcow2");
      if (existsSync(goldenDeps)) return goldenDeps;
      const depsBase = join(import.meta.dir, "qemu-images/base-with-deps.qcow2");
      if (existsSync(depsBase)) return depsBase;
      const uvBase = join(import.meta.dir, "qemu-images/base-with-uv.qcow2");
      if (existsSync(uvBase)) return uvBase;
      return join(import.meta.dir, "qemu-images/base.qcow2");
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

interface TestCaseFile {
  file: string;
  expected: string;
}

// Load test matrix (only needed for parallel mode)
let testMatrix: any = undefined;
function loadTestMatrix(): any {
  if (!testMatrix) {
    const testMatrixPath = join(import.meta.dir, "fixtures/test-matrix.json");
    if (!existsSync(testMatrixPath)) {
      throw new Error(`Test matrix not found: ${testMatrixPath}\nCreate it or run without --parallel.`);
    }
    testMatrix = JSON.parse(readFileSync(testMatrixPath, "utf-8"));
  }
  return testMatrix;
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

  // Set deployer on shell for fast D-Bus address resolution
  shell.setDeployer(vm.deployer);

  const tmuxCfg: tmux.TmuxHelper = {
    session: `e2e-${run.id}`,
    sshKey: SSH_KEY,
    sshPort: run.sshPort,
    sshUser: SSH_USER,
    deployer: vm.deployer,
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
  await tmux.killSession(tmuxCfg);
  const hasGhostty = (await shell.exec(`which ghostty 2>/dev/null`)).trim().length > 0;
  if (hasGhostty) {
    await shell.exec(`nohup ghostty -e tmux new-session -s ${tmuxCfg.session} -x 120 -y 40 &>/dev/null &`);
  } else {
    await shell.exec(`nohup gnome-terminal -- bash -c "tmux new-session -s ${tmuxCfg.session} -x 120 -y 40" &>/dev/null &`);
  }
  // Poll until tmux session appears (usually <1s; 5s is a generous ceiling)
  await vm.pollUntil(
    "tmux session",
    async () => {
      try {
        const output = await shell.exec(`tmux list-sessions 2>/dev/null | grep ${tmuxCfg.session}`);
        return output.trim().length > 0;
      } catch {
        return false; // ssh hiccup — retry
      }
    },
    5000
  );
  // Click on the terminal to ensure it has focus
  await shell.dotoolCommand("mousemove 640 400");
  await shell.dotoolCommand("buttondown 1");
  await shell.dotoolCommand("buttonup 1");
  // Brief wait for window manager to settle after click
  await Bun.sleep(500);

  // Verify terminal is focused by typing a test character and checking tmux
  const paneBefore = await tmux.capturePane(tmuxCfg);
  await shell.dotoolCommand("key shift+space"); // type space to confirm dotool works
  await Bun.sleep(200);
  const paneAfter = await tmux.capturePane(tmuxCfg);
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
  const preRecordingPane = await tmux.capturePane(tmuxCfg);
  console.log("Pre-recording pane captured.");
  timing("snapshot-pane", t);

  t = Date.now();
  await vm.captureFrame("03-pre-recording");
  timing("capture-frame", t);

  // Start screen recording now so the basic test AND the preferences window are both captured
  t = Date.now();
  const screencastDir = join(run.outputDir, "test-cases", getTestCaseName());
  mkdirSync(screencastDir, { recursive: true });
  let screencastFile = "";
  let useXvfbRecording = false;
  // Guarantee ffmpeg cleanup on any exit path
  process.on('exit', () => {
    try { vm['recordingFfmpeg']?.kill('SIGKILL'); } catch { /* best-effort */ }
    try { vm['xvfbProcess']?.kill('SIGKILL'); } catch { /* best-effort */ }
  });
  try {
    vm.startRecording();
    useXvfbRecording = true;
  } catch (e) {
    console.log(`  Xvfb recording not available: ${e}`);
    // Fallback to GNOME Shell screencast
    try {
      screencastFile = await shell.startScreencast("/tmp/e2e-screencast");
      console.log(`  Screencast started: ${screencastFile}`);
    } catch (e2) {
      console.log(`  Screencast start failed: ${e2}`);
    }
  }
  timing("start-screencast", t);

  // Ensure Activities is dismissed and terminal focused before the hotkey
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
        try {
          const logOutput = await shell.exec(
            `grep -oP 'Transcription result: \\K.*' /tmp/voice-service.log 2>/dev/null | tail -1`
          );
          const trimmed = logOutput.trim();
          if (trimmed && !/^\s*(?:\[[^\]]*\]\s*)?\S+@\S+/.test(trimmed)) {
            transcription = trimmed;
            console.log(`  Got from log: ${transcription}`);
            return true;
          }
        } catch {
          return false; // ssh hiccup — retry
        }
        return false;
      },
      45000,
      500
    );
    // If log didn't have it, try tmux capture as fallback
    if (!transcription) {
      console.log("  Log poll timed out, trying tmux capture...");
      const paneContent = await tmux.capturePane(tmuxCfg);
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
    try {
      const logTail = await shell.exec("tail -n 25 /tmp/voice-service.log 2>/dev/null || echo '(no voice-service log)'");
      console.log("  voice-service log tail:\n" + logTail.trim().split("\n").map((l) => "    " + l).join("\n"));
    } catch {
      // diagnostics are best-effort
    }
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

  // Basic test complete. Close the terminal so it doesn't appear in the preferences screenshots.
  console.log("Closing terminal before preferences tests...");
  await tmux.killSession(tmuxCfg);
  await shell.exec("pkill -f ghostty 2>/dev/null; pkill -f gnome-terminal 2>/dev/null; true");
  // Poll until the terminal emulator has actually exited (no blind sleep).
  // Use one-shot ssh with swallow-on-error: shell.exec can throw if the
  // persistent connection hiccups right after tmux kill, and pgrep matching
  // nothing returns empty via `; true`.
  await vm.pollUntil(
    "terminal closed",
    async () => {
      try {
        // [g]hostty bracket trick: prevents pgrep from matching this very
        // ssh command's own cmdline (sh -c "...ghostty...").
        const out = await shell.exec("pgrep -f '[g]hostty'; pgrep -f '[g]nome-terminal'; true");
        return out.trim().length === 0;
      } catch {
        return false;
      }
    },
    5000
  );

  // Open preferences window (still inside the screen recording).
  t = Date.now();
  await runPreferencesTests(vm, run);
  timing("preferences-screenshots", t);

  // Stop screen recording
  t = Date.now();
  if (useXvfbRecording) {
    await vm.stopRecording();
  } else if (screencastFile) {
    try {
      await shell.stopScreencast();
      console.log(`  Screencast stopped: ${screencastFile}`);
    } catch (e) {
      console.log(`  Screencast stop failed: ${e}`);
    }
  }
  timing("stop-screencast", t);

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
  await tmux.killSession(tmuxCfg);

  // Retrieve screencast file from VM
  // Retrieve screencast file from VM
  if (screencastFile) {
    // Validate path: must be an absolute path, no traversal, ends with .webm
    if (!/^\/tmp\/e2e-screencast[^']*\.webm$/.test(screencastFile)) {
      console.log(`  Screencast file path rejected: ${screencastFile}`);
    } else {
      t = Date.now();
      const localPath = join(screencastDir, "test-recording.webm");
      try {
        execSync(
          `scp -o StrictHostKeyChecking=no -i ${SSH_KEY} -P ${run.sshPort} testuser@localhost:${screencastFile} ${localPath}`,
          { encoding: "utf-8", timeout: 10000 }
        );
        const stats = require("node:fs").statSync(localPath);
        console.log(`  Screencast saved: ${localPath} (${(stats.size / 1024).toFixed(1)}KB)`);
      } catch (e) {
        console.log(`  Screencast retrieval failed: ${e}`);
      }
      timing("retrieve-screencast", t);
    }
  }
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
 * Create a video from screenshots using ffmpeg.
 */
function createVideoFromScreenshots(run: RunContext): void {
  const recordingDir = join(run.outputDir, "recording");
  const outputDir = join(run.outputDir, "test-cases", getTestCaseName());
  const videoPath = join(outputDir, "test-recording.mp4");
  const screenshotPattern = join(recordingDir, "frame-*.ppm");
  
  try {
    // Check if ffmpeg is available
    execSync("which ffmpeg", { stdio: "ignore" });
    
    // Check if there are any screenshots
    const files = require("node:fs").readdirSync(recordingDir).filter((f: string) => f.startsWith("frame-") && f.endsWith(".ppm"));
    if (files.length === 0) {
      return;
    }
    
    // Create video from screenshots
    // Each screenshot shows for 2 seconds (6 screenshots = 12 seconds total)
    execSync(
      `ffmpeg -y -framerate 0.5 -pattern_type glob -i '${screenshotPattern}' -c:v libx264 -r 30 -pix_fmt yuv420p "${videoPath}" 2>/dev/null`,
      { stdio: "ignore" }
    );
    
    if (existsSync(videoPath)) {
      const stats = require("node:fs").statSync(videoPath);
      console.log(`  Video saved: ${videoPath} (${(stats.size / 1024).toFixed(1)}KB)`);
    }
  } catch {
    // ffmpeg not available or failed - skip video creation
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
        `compare -metric MSE "${referencePath}" "${screenshot}" "${diffPath}" 2>&1 || true`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim();
      
      const mse = parseFloat(result);
      if (!Number.isFinite(mse) || mse >= 100) {
        return { passed: false, message: `Visual regression: MSE=${result} (threshold=100)`, screenshot };
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
  
  // Copy preferences screenshots
  const prefsRefDir = join(CONFIG.paths.referencesDir, "preferences");
  mkdirSync(prefsRefDir, { recursive: true });
  const prefsNames = ["prefs-main", "prefs-scrolled-1", "prefs-scrolled-2", "prefs-scrolled-3", "prefs-after-add"];
  for (const name of prefsNames) {
    const src = join(run.outputDir, "preferences", `${name}.png`);
    if (existsSync(src)) {
      execSync(`cp "${src}" "${prefsRefDir}/screenshot-${name}.png"`, { encoding: "utf-8" });
      console.log(`  Copied: ${name} → preferences/`);
    }
  }
}
/**
 * Compare a captured screenshot against its reference in expected-qemu/preferences/.
 * Fails if MSE >= threshold. Skips (logs) when no reference exists yet.
 */
async function compareWithReference(name: string, captured: string, run: RunContext): Promise<void> {
  const referencePath = join(CONFIG.paths.referencesDir, "preferences", `screenshot-${name}.png`);
  if (!existsSync(referencePath)) {
    console.log(`  No reference for ${name}: ${referencePath} (run with --update to create)`);
    return;
  }
  try {
    const diffPath = join(run.outputDir, "preferences", `diff-${name}.png`);
    const result = execSync(
      `compare -metric MSE "${referencePath}" "${captured}" "${diffPath}" 2>&1 || true`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    // compare prints "<mse> (<normalized>)" and exits 1 whenever images differ
    // (even negligibly) — parse stdout instead of relying on exit code.
    const mse = parseFloat(result);
    if (!Number.isFinite(mse) || mse >= 100) {
      throw new Error(`Visual regression on ${name}: MSE=${result} (threshold=100), diff: ${diffPath}`);
    }
    console.log(`  ${name}: MSE=${mse} (pass)`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Visual regression")) throw err;
    console.log(`  ${name} visual check failed: ${err}`);
  }
}

/**
 * Run preferences screenshot tests.
 * Opens preferences and takes screenshots of each section.
 */
async function runPreferencesTests(vm: VmManager, run: RunContext): Promise<void> {
  console.log("\n📸 Running preferences screenshot tests...");
  
  const prefsDir = join(run.outputDir, "preferences");
  mkdirSync(prefsDir, { recursive: true });
  
  // Open preferences window using gnome-extensions prefs command
  console.log("  Opening preferences window...");
  await vm.deployer.exec(
    `export DISPLAY=:0; export XDG_RUNTIME_DIR=/run/user/$(id -u); gnome-extensions prefs voice-to-text@happytomatoe.com &`
  );
  
  // Wait for window to appear
  await Bun.sleep(3000);
  
  // Dismiss any welcome/tour dialogs that may appear
  console.log("  Dismissing welcome dialogs...");
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "key Escape" | dotool`
  );
  await Bun.sleep(500);
  // Click Skip button if tour dialog appears
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "mouseto 0.42 0.76\nclick left" | dotool`
  );
  await Bun.sleep(1000);
  
  // Capture a prefs screenshot via QEMU monitor screendump (full display).
  // CodeRabbit suggested portal/Shell.Screenshot here, but Eval is disabled
  // in GNOME 50 and portal adds a permission dialog without window accuracy
  // gains — screendump was correct all along.
  const capturePrefs = async (name: string): Promise<string> => {
    const png = join(prefsDir, `${name}.png`);
    const ppm = join(prefsDir, `${name}.ppm`);
    await vm.qemu.screendump(ppm);
    await Bun.sleep(500);
    execSync(`convert "${ppm}" "${png}" 2>/dev/null || true`, { encoding: "utf-8" });
    execSync(`rm -f "${ppm}"`, { encoding: "utf-8" });
    console.log(`  📷 Captured: ${name}.png`);
    return png;
  };

  // Take screenshot of main preferences window
  const mainPng = await capturePrefs("prefs-main");
  
  // Scroll down to see more settings using dotool (works on Wayland)
  console.log("  Scrolling down to see more settings...");
  // First click on the preferences window to focus it
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "mouseto 0.5 0.5\nclick left" | dotool`
  );
  await Bun.sleep(500);
  // Then scroll down using dotool wheel (negative = scroll down)
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "wheel -5" | dotool`
  );
  await Bun.sleep(1000);
  
  const scroll1Png = await capturePrefs("prefs-scrolled-1");
  
  // Scroll down more
  console.log("  Scrolling down more...");
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "wheel -5" | dotool`
  );
  await Bun.sleep(1000);
  
  const scroll2Png = await capturePrefs("prefs-scrolled-2");
  
  // Scroll down even more
  console.log("  Scrolling down even more...");
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "wheel -5" | dotool`
  );
  await Bun.sleep(1000);
  
  const scroll3Png = await capturePrefs("prefs-scrolled-3");
  
  // Test adding a new word via the Add Word button
  console.log("  Testing Add Word functionality...");
  // Click on "Add Word..." button (it's at the top of the custom words list)
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "mouseto 0.39 0.43\nclick left" | dotool`
  );
  await Bun.sleep(1000);
  
  // Type a new word in the dialog
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "type E2E" | dotool`
  );
  await Bun.sleep(500);
  // Click the Add button
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "mouseto 0.62 0.58\nclick left" | dotool`
  );
  await Bun.sleep(1000);
  
  const afterAddPng = await capturePrefs("prefs-after-add");
  
  // Verify screenshot was captured and has content
  if (!existsSync(afterAddPng)) {
    throw new Error("prefs-after-add.png was not created");
  }
  const stats = Bun.file(afterAddPng);
  if (stats.size < 1000) {
    throw new Error(`prefs-after-add.png is too small (${stats.size} bytes), screenshot likely failed`);
  }
  console.log("  📷 Captured: prefs-after-add.png (should show E2E at top of list)");
  console.log(`  ✅ Screenshot verified: ${stats.size} bytes`);
  
  // Visual regression: compare each capture against its reference (if one exists)
  const captures: Array<[string, string]> = [
    ["prefs-main", mainPng],
    ["prefs-scrolled-1", scroll1Png],
    ["prefs-scrolled-2", scroll2Png],
    ["prefs-scrolled-3", scroll3Png],
    ["prefs-after-add", afterAddPng],
  ];
  for (const [name, captured] of captures) {
    await compareWithReference(name, captured, run);
  }
  
  // Close preferences window using dotool
  console.log("  Closing preferences window...");
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "key alt+F4" | dotool`
  );
  await Bun.sleep(500);
  
  console.log("  ✅ Preferences tests completed");
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
    outputMethod: OUTPUT_METHOD,
    skipDeps: SKIP_DEPS,
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


  // Handle parallel mode
  if (PARALLEL_VMS > 1) {
    console.log(`\n🚀 Running in parallel mode with ${PARALLEL_VMS} VMs`);
    
    // Load test cases from matrix
    const testCases: TestCase[] = loadTestMatrix()["test-suites"].transcription["test-cases"].map((tc: any) => ({
      id: tc.id,
      audioFile: loadTestMatrix()["test-suites"].transcription["matrix"]["audio-files"].find((a: any) => a.id === tc.audio).file,
      expectedText: loadTestMatrix()["test-suites"].transcription["matrix"]["audio-files"].find((a: any) => a.id === tc.audio).expected,
      outputMethod: tc["output-method"],
      priority: tc.priority
    }));
    
    const runner = new ParallelTestRunner({
      maxVMs: PARALLEL_VMS,
      testCases,
      outputDir: join(import.meta.dir, "output", "parallel"),
      baseImage: BASE_IMAGE,
      sshKey: SSH_KEY,
      sshUser: SSH_USER,
      projectRoot: PROJECT_ROOT,
      pythonSrc: PYTHON_SRC,
      fixtureDir: join(import.meta.dir, "fixtures"),
      extensionUuid: CONFIG.extension.uuid,
      recordMode: RECORD_MODE,
      updateMode: UPDATE_MODE,
      skipDeps: SKIP_DEPS,
    });
    
    const results = await runner.runAll();
    runner.printSummary();
    
    const passed = [...results.values()].filter(r => r.passed).length;
    const failed = [...results.values()].filter(r => !r.passed).length;
    
    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
  
  // Handle preferences tests mode
  if (TEST_PREFS) {
    console.log("\n📸 Running preferences screenshot tests");
    
    await new StepRunner().run([
      { name: "preflight", fn: preflight },
      { name: "boot-vm", fn: () => vm.boot(), timeout: 120_000 },
      { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 120_000 },
      { name: "setup", fn: () => vm.setupForPrefs(), timeout: 600_000 },
    ]);
    
    await runPreferencesTests(vm, run);
    
    console.log("\n✅ Preferences tests completed");
    process.exit(0);
  }
  try {
    if (SNAPSHOT_MODE) {
      // Snapshot mode: restore if exists, otherwise deploy and save
      // Check snapshot BEFORE boot — with -loadvm the guest resumes directly
      // from the snapshot instead of doing a full boot.
      let t = Date.now();
      await preflight();
      const hasSnap = await vm.hasSnapshot("ready");
      let restored = false;
      
      if (hasSnap) {
        console.log("\n--- Snapshot 'ready' found, booting with -loadvm ---");
        try {
          await vm.boot("ready");
          // After -loadvm, reconnect shell + verify service
          await vm.waitForSshHandshake();
          await vm.reconnectAfterRestore();
          restored = true;
        } catch (e) {
          console.log(`-loadvm boot failed (${e}), falling back to fresh boot`);
        }
      }
      
      if (!restored) {
        console.log("\n--- No snapshot restore, deploying fresh ---");
        await new StepRunner().run([
          { name: "boot-vm", fn: () => vm.boot(), timeout: 120_000 },
          { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 120_000 },
          { name: "setup", fn: () => vm.setup(), timeout: 600_000 },
          ...(NO_SAVE_SNAPSHOT
            ? []
            : [{ name: "save-snapshot", fn: () => vm.saveCleanSnapshot("ready") }]),
        ]);
        timing("deploy-and-save-snapshot", t);
      } else {
        timing("restore-snapshot", t);
        // Deploy test audio for this specific test case (snapshot has old audio)
        deployTestAudio(vm.deployCfg);
        // Snapshot restore resumes OLD guest state — always redeploy the
        // extension so the run executes CURRENT code (install.sh --local is
        // idempotent and cheap); otherwise any code change after the snapshot
        // save is invisible to e2e.
        await deployExtension(vm.shell, vm.deployCfg, vm.pollUntil, vm.deployer);
        // The service process thawed from the snapshot is a zombie: its threads
        // do not survive -loadvm (bus name answers, transcription never runs).
        // Kill it and start a fresh one with current code + env, mirroring the
        // fresh-deploy path so a restored VM runs current code in EVERY
        // component, not just the extension.
        await vm.shell.exec("killall -9 python3 2>/dev/null; true");
        // Poll until the zombie is actually dead before restarting — a fixed
        // sleep races a dying process (same pattern as waitQemuGone).
        await vm.pollUntil(
          "old voice service dead",
          async () => {
            try {
              const out = await vm.shell.exec("pgrep -f 'python3 -m voice_to_text'; true");
              return out.trim().length === 0;
            } catch {
              return false; // ssh hiccup — retry
            }
          },
          10000,
        );
        await startVoiceService(
          vm.shell, vm.deployCfg, vm.pollUntil, vm.pollForCommandOutput, true,
        );
      }
      
      // Run test
      await runTestFlow(vm, run);
      const result = await verifyWithScreenshot(vm, EXPECTED_TEXT, run);
      
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
        { name: "setup", fn: () => vm.setup(), timeout: 600_000 },
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
    if (!KEEP_VM) {
      // Hard cap on shutdown: QEMU monitor / ssh2 teardown can hang forever on
      // a dead socket. Never let cleanup block the exit code.
      await Promise.race([
        vm.shutdown().catch((err) => console.log(`  shutdown warning: ${err instanceof Error ? err.message : err}`)),
        Bun.sleep(20000).then(() => console.log("  shutdown timed out after 20s — killing VM process")),
      ]);
      run.cleanup();
      console.log("\nVM shut down.");
    } else {
      console.log("\nVM kept running (pass --keep-vm to leave it up)");
      console.log(`SSH: ssh -i ${SSH_KEY} -p ${run.sshPort} ${SSH_USER}@localhost`);
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
    console.log("\n--- E2E Test Failure Help ---");
    console.log("For E2E debugging, read the skills:");
    console.log("  .agents/skills/e2e-debugging/SKILL.md  — VM lifecycle, screenshots, deployment");
    console.log("  .agents/skills/e2e-setup/SKILL.md      — First-time VM setup");
    process.exit(1);
  }
}

main();
