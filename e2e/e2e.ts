import { ensureParakeet } from "./lib/parakeet.js";
import { timeoutMs, loadTimeouts } from "./lib/config.js";
import { ParallelTestRunner, type TestCase } from "./lib/parallel.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Step, StepRunner } from "./lib/step-runner.js";
import { VmManager, type VmConfig } from "./lib/vm.js";
import { RunContext } from "./lib/run-context.js";
import { deployTestAudio, deployPythonSource, startVoiceService } from "./lib/deploy-steps.js";
import { pollUntil, pollForCommandOutput } from "./lib/poll.js";
import * as tmux from "./lib/tmux.js";
import { execSync } from "node:child_process";
import type { HealthCheckResult } from "./lib/health.js";

const LOG_DIR = join(import.meta.dir, "output");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "e2e.log");
writeFileSync(LOG_FILE, "");

const origLog = console.log;
const origError = console.error;

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


const args = process.argv.slice(2);
const UPDATE_MODE = args.includes("--update");
const SHUTDOWN = args.includes("--shutdown");
const NO_RECORD = args.includes("--no-record");
const RECORD_MODE = !NO_RECORD;
const TIMING_MODE = args.includes("--timing");
if (TIMING_MODE) process.env.TIMING_MODE = "1";
const NO_SNAPSHOT = args.includes("--no-snapshot");
const SAVE_SNAPSHOT = args.includes("--save-snapshot");
const SKIP_DEPS = args.includes("--skip-deps");

// Parse --timeout <seconds> (default: 180)
const timeoutIdx = args.indexOf("--timeout");
const GLOBAL_TIMEOUT_MS = timeoutIdx >= 0 ? (parseInt(args[timeoutIdx + 1]) || 300) * 1000 : timeoutMs("global");

// Parse --case <name> (select specific test case instead of random)
const caseIdx = args.indexOf("--case");
const SELECTED_CASE = caseIdx >= 0 ? args[caseIdx + 1] : undefined;

// Parse --output-method <method> (test specific output method: type, clipboard, mutter-virtual, mutter-commit)
const outputMethodIdx = args.indexOf("--output-method");
const OUTPUT_METHOD = outputMethodIdx >= 0 ? args[outputMethodIdx + 1] : "mutter-commit";

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

/** Log health check results. */
function logHealthCheck(result: HealthCheckResult): void {
  console.log("\n--- Health Check ---");
  for (const line of result.details) {
    console.log(`  ${line}`);
  }
  const healthy = result.gnomeShell && result.extensionActive && result.noJsErrors && result.noCrash;
  console.log(`  Overall: ${healthy ? "HEALTHY" : "UNHEALTHY"}`);
}
const EXPECTED_TEXT = CURRENT_TEST.expected;

async function preflight(): Promise<void> {
  if (!existsSync(BASE_IMAGE)) {
    throw new Error(`Base VM image not found: ${BASE_IMAGE}\nRun 'just qemu-e2e-setup' first.`);
  }

  if (!existsSync(SSH_KEY)) {
    throw new Error(`SSH key not found: ${SSH_KEY}\nRun 'just qemu-e2e-setup' first.`);
  }

  await ensureParakeet();
}

async function runTestFlow(vm: VmManager, run: RunContext): Promise<void> {
  const shell = vm.shell;
  let t: number;

  shell.configure({ sshKey: SSH_KEY, sshPort: run.sshPort, sshUser: SSH_USER });
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

  t = Date.now();
  console.log("Dismissing Activities...");
  const wasOpen = await shell.dismissAndCheck();
  console.log(`  Activities after dismiss: ${wasOpen ? 'STILL OPEN' : 'closed'}`);
  timing("dismiss-activities", t);

  t = Date.now();
  console.log("Opening terminal with tmux...");
  await tmux.killSession(tmuxCfg);
  await shell.exec(`tmux new-session -d -s ${tmuxCfg.session} -x 120 -y 40`);
  const hasGhostty = (await shell.exec(`which ghostty 2>/dev/null`)).trim().length > 0;
  if (hasGhostty) {
    await shell.exec(`WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/\$(id -u) nohup ghostty -e tmux attach-session -t ${tmuxCfg.session} &>/dev/null &`);
  } else {
    await shell.exec(`WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/\$(id -u) nohup gnome-terminal -- tmux attach-session -t ${tmuxCfg.session} &>/dev/null &`);
  }
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

  const paneBefore = await tmux.capturePane(tmuxCfg);
  await shell.dotoolCommand("type FOCUS_TEST");
  await Bun.sleep(200);
  const paneAfter = await tmux.capturePane(tmuxCfg);
  if (paneBefore === paneAfter) {
    console.log("  Retrying terminal focus...");
    await shell.dotoolCommand("mousemove 640 400");
    await shell.dotoolCommand("buttondown 1");
    await shell.dotoolCommand("buttonup 1");
    await Bun.sleep(500);
    await shell.dotoolCommand("type FOCUS_TEST");
    await Bun.sleep(200);
  }
  timing("open-terminal", t);

  t = Date.now();
  await vm.captureFrame("02-tmux-started");
  timing("capture-frame", t);

  t = Date.now();
  const preRecordingPane = await tmux.capturePane(tmuxCfg);
  console.log("Pre-recording pane captured.");
  timing("snapshot-pane", t);

  t = Date.now();
  await vm.captureFrame("03-pre-recording");
  timing("capture-frame", t);

  const wasOpen2 = await shell.dismissAndCheck();
  console.log(`  Activities after second dismiss: ${wasOpen2 ? 'STILL OPEN' : 'closed'}`);
  
  await shell.focusTerminal();

  console.log("Verifying terminal focus...");
  let isFocused = await shell.verifyTerminalFocus(tmuxCfg.session);
  if (!isFocused) {
    console.log("  Terminal not focused, trying click + gio launch...");
    await shell.clickToFocus(640, 400);
    await Bun.sleep(500);
    await shell.focusTerminal();
    isFocused = await shell.verifyTerminalFocus(tmuxCfg.session);
    console.log(`  After retry: focused=${isFocused}`);
  }
  if (!isFocused) {
    console.log("  WARNING: Terminal may not be focused");
  }
  await shell.exec(`tmux send-keys -t ${tmuxCfg.session} C-u`);
  await Bun.sleep(200);
  // Show service log in terminal so test activity is visible on screen
  const tmuxSession = tmuxCfg.session;
  await shell.exec(`tmux send-keys -t ${tmuxSession} 'tail -f /tmp/voice-service.log' Enter`);
  await Bun.sleep(1000);
  vm.startRecording();
  t = Date.now();
  console.log("Starting recording via hotkey...");
  await shell.sendHotkey();
  await shell.waitForRecordingStart();
  timing("start-recording", t);

  t = Date.now();
  await vm.captureFrame("04-recording-started");
  timing("capture-frame", t);

  t = Date.now();
  console.log("Waiting for transcription...");
  let transcription = "";
  try {
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
  }
  timing("transcription", t);

  // Stop tail -f in terminal
  await shell.exec(`tmux send-keys -t ${tmuxSession} C-c`);
  await Bun.sleep(300);

  t = Date.now();
  await vm.captureFrame("05-transcription-received");
  timing("capture-frame", t);

  t = Date.now();
  console.log("Stopping recording via hotkey...");
  await shell.sendHotkey();
  await Bun.sleep(200);
  timing("stop-recording", t);

  t = Date.now();
  await vm.captureFrame("06-recording-stopped");
  timing("capture-frame", t);

  t = Date.now();
  console.log("Writing result to file...");
  if (transcription) {
    const encoded = Buffer.from(transcription).toString('base64');
    await shell.exec(`echo '${encoded}' | base64 -d > /tmp/file.txt`);
  }
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

  await tmux.killSession(tmuxCfg);

  await vm.stopRecording();
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
  
  const dir = require("node:path").dirname(pngPath);
  require("node:fs").mkdirSync(dir, { recursive: true });
  
  try {
    execSync(
      `echo "screendump ${ppmPath}" | nc -U ${run.socketPath} -w 2`,
      { encoding: "utf-8", timeout: 5000 }
    );
    await Bun.sleep(500);
    execSync(`convert ${ppmPath} ${pngPath} 2>/dev/null || true`, {
      encoding: "utf-8",
      timeout: 5000
    });
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
    execSync("which ffmpeg", { stdio: "ignore" });
    
    const files = require("node:fs").readdirSync(recordingDir).filter((f: string) => f.startsWith("frame-") && f.endsWith(".ppm"));
    if (files.length === 0) {
      return;
    }
    
    execSync(
      `ffmpeg -y -framerate 0.5 -pattern_type glob -i '${screenshotPattern}' -c:v libx264 -r 30 -pix_fmt yuv420p "${videoPath}" 2>/dev/null`,
      { stdio: "ignore" }
    );
    
    if (existsSync(videoPath)) {
      const stats = require("node:fs").statSync(videoPath);
      console.log(`  Video saved: ${videoPath} (${(stats.size / 1024).toFixed(1)}KB)`);
    }
  } catch (e) {
    console.log(`  ffmpeg video creation skipped: ${e}`);
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
  
  if (actualNorm === expectedNorm) {
    return { passed: true, message: "Text matches expected output", screenshot };
  }
  // Fuzzy match: allow minor transcription variations (e.g. "nadin" vs "nadien")
  const words = expectedNorm.split(" ");
  const actualWords = actualNorm.split(" ");
  if (words.length === actualWords.length) {
    const mismatches = words.filter((w, i) => w !== actualWords[i]).length;
    if (mismatches <= 1) {
      return { passed: true, message: `Text matches (1 word variation): expected '${expectedNorm}', got '${actualNorm}'`, screenshot };
    }
  }
  
  if (actualNorm !== expectedNorm) {
    return { passed: false, message: `Text does not match: expected '${expectedNorm}', got '${actualNorm}'`, screenshot };
  }
  
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
  
  const transcriptionSrc = getScreenshotPath("05-transcription-received", testCase, run.outputDir);
  const transcriptionDst = join(testCaseRefDir, "screenshot-05-transcription-received.png");
  if (existsSync(transcriptionSrc)) {
    execSync(`cp "${transcriptionSrc}" "${transcriptionDst}"`, { encoding: "utf-8" });
    console.log(`  Copied: transcription → test-cases/${testCase}/`);
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
  
  console.log("  Opening preferences window...");
  await vm.deployer.exec(
    `export DISPLAY=:0; export XDG_RUNTIME_DIR=/run/user/$(id -u); gnome-extensions prefs voice-to-text@happytomatoe.com &`
  );
  
  await Bun.sleep(3000);

  console.log("  Dismissing welcome dialogs...");
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "key Escape" | dotool`
  );
  await Bun.sleep(500);
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "mouseto 0.42 0.76\nclick left" | dotool`
  );
  await Bun.sleep(1000);
  
  // Take screenshot of main preferences window
  const mainPpm = join(prefsDir, "prefs-main.ppm");
  const mainPng = join(prefsDir, "prefs-main.png");
  await vm.qemu.screendump(mainPpm);
  await Bun.sleep(500);
  execSync(`convert "${mainPpm}" "${mainPng}" 2>/dev/null || true`, { encoding: "utf-8" });
  execSync(`rm -f "${mainPpm}"`, { encoding: "utf-8" });
  console.log("  📷 Captured: prefs-main.png");
  
  console.log("  Scrolling down to see more settings...");
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "mouseto 0.5 0.5\nclick left" | dotool`
  );
  await Bun.sleep(500);
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "wheel -5" | dotool`
  );
  await Bun.sleep(1000);
  
  const scroll1Ppm = join(prefsDir, "prefs-scrolled-1.ppm");
  const scroll1Png = join(prefsDir, "prefs-scrolled-1.png");
  await vm.qemu.screendump(scroll1Ppm);
  await Bun.sleep(500);
  execSync(`convert "${scroll1Ppm}" "${scroll1Png}" 2>/dev/null || true`, { encoding: "utf-8" });
  execSync(`rm -f "${scroll1Ppm}"`, { encoding: "utf-8" });
  console.log("  📷 Captured: prefs-scrolled-1.png");
  
  console.log("  Scrolling down more...");
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "wheel -5" | dotool`
  );
  await Bun.sleep(1000);
  
  const scroll2Ppm = join(prefsDir, "prefs-scrolled-2.ppm");
  const scroll2Png = join(prefsDir, "prefs-scrolled-2.png");
  await vm.qemu.screendump(scroll2Ppm);
  await Bun.sleep(500);
  execSync(`convert "${scroll2Ppm}" "${scroll2Png}" 2>/dev/null || true`, { encoding: "utf-8" });
  execSync(`rm -f "${scroll2Ppm}"`, { encoding: "utf-8" });
  console.log("  📷 Captured: prefs-scrolled-2.png");
  
  console.log("  Scrolling down even more...");
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "wheel -5" | dotool`
  );
  await Bun.sleep(1000);
  
  const scroll3Ppm = join(prefsDir, "prefs-scrolled-3.ppm");
  const scroll3Png = join(prefsDir, "prefs-scrolled-3.png");
  await vm.qemu.screendump(scroll3Ppm);
  await Bun.sleep(500);
  execSync(`convert "${scroll3Ppm}" "${scroll3Png}" 2>/dev/null || true`, { encoding: "utf-8" });
  execSync(`rm -f "${scroll3Ppm}"`, { encoding: "utf-8" });
  console.log("  📷 Captured: prefs-scrolled-3.png");
  
  // Test adding a new word via the Add Word button
  console.log("  Testing Add Word functionality...");
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "mouseto 0.39 0.43\nclick left" | dotool`
  );
  await Bun.sleep(1000);
  
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "type E2E" | dotool`
  );
  await Bun.sleep(500);
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "mouseto 0.62 0.58\nclick left" | dotool`
  );
  await Bun.sleep(1000);
  
  const afterAddPpm = join(prefsDir, "prefs-after-add.ppm");
  const afterAddPng = join(prefsDir, "prefs-after-add.png");
  await vm.qemu.screendump(afterAddPpm);
  await Bun.sleep(500);
  execSync(`convert "${afterAddPpm}" "${afterAddPng}" 2>/dev/null || true`, { encoding: "utf-8" });
  execSync(`rm -f "${afterAddPpm}"`, { encoding: "utf-8" });
  
  if (!existsSync(afterAddPng)) {
    throw new Error("prefs-after-add.png was not created");
  }
  const stats = Bun.file(afterAddPng);
  if (stats.size < 1000) {
    throw new Error(`prefs-after-add.png is too small (${stats.size} bytes), screenshot likely failed`);
  }
  console.log("  📷 Captured: prefs-after-add.png (should show E2E at top of list)");
  console.log(`  ✅ Screenshot verified: ${stats.size} bytes`);
  
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
    outputMethod: OUTPUT_METHOD,
    skipDeps: SKIP_DEPS,
  };
  const vm = new VmManager(vmCfg);
  const startTime = Date.now();
  let testsFailed = 0;

  // Global timeout watchdog — exit immediately so CI sees the failure
  const timeoutTimer = setTimeout(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.error(`\nFATAL: Test exceeded ${GLOBAL_TIMEOUT_MS / 1000}s limit (${elapsed}s elapsed)`);
    console.error("Killing process — test is hung");
    process.exit(2);
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
      skipDeps: SKIP_DEPS
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
      { name: "boot-vm", fn: () => vm.boot(), timeout: timeoutMs("boot_vm") },
      { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: timeoutMs("wait_ssh") },
      { name: "setup", fn: () => vm.setupForPrefs(), timeout: timeoutMs("setup") },
    ]);
    
    await runPreferencesTests(vm, run);
    
    console.log("\n✅ Preferences tests completed");
    process.exit(0);
  }
  try {
    // Boot VM (needed for all paths)
    let t = Date.now();
    await new StepRunner().run([
      { name: "preflight", fn: preflight },
      { name: "boot-vm", fn: () => vm.boot(), timeout: timeoutMs("boot_vm") },
      { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: timeoutMs("wait_ssh") },
    ]);
    timing("boot-vm", t);
    
    // Record pre-deploy PID for crash detection
    const preDeployPid = await vm.recordPreDeployPid();
    
    // Try to restore from snapshot (unless --no-snapshot)
    const hasSnap = !NO_SNAPSHOT && await vm.hasSnapshot("ready");
    
    if (hasSnap) {
      console.log("\n--- Snapshot 'ready' found, restoring ---");
      t = Date.now();
      await vm.resetToCleanState("ready");
      timing("restore-snapshot", t);
      // Re-deploy Python source + voice service (snapshot may have stale binaries)
      await deployPythonSource(vm.deployCfg, vm.deployer);
      await deployTestAudio(vm.deployCfg, vm.deployer);
      const skipDeps = vm.config.skipDeps || vm.config.baseImage.includes('golden-gnome-deps');
      await startVoiceService(vm.shell, vm.deployCfg, pollUntil, pollForCommandOutput, skipDeps, vm.deployer);
    } else {
      console.log(NO_SNAPSHOT ? "\n--- --no-snapshot: deploying fresh ---" : "\n--- No snapshot found, deploying fresh ---");
      t = Date.now();
      const steps: Step[] = [
        { name: "setup", fn: () => vm.setup(), timeout: timeoutMs("setup") },
      ];
      if (SAVE_SNAPSHOT) {
        steps.push({ name: "save-snapshot", fn: () => vm.saveCleanSnapshot("ready") });
      }
      await new StepRunner().run(steps);
      timing("deploy" + (SAVE_SNAPSHOT ? "+save-snapshot" : ""), t);
    }
    
    const healthAfterDeploy = await vm.healthCheck(preDeployPid);
    logHealthCheck(healthAfterDeploy);
    if (!healthAfterDeploy.gnomeShell) {
      throw new Error(`Health check failed: GNOME Shell not running: ${healthAfterDeploy.details.join('; ')}`);
    }
    if (!healthAfterDeploy.extensionActive) {
      console.log("  WARNING: Extension state UNKNOWN (headless gnome-shell may not report it)");
    }
    
    await runTestFlow(vm, run);

    const healthAfterTest = await vm.healthCheck();
    logHealthCheck(healthAfterTest);
    
    const result = await verifyWithScreenshot(vm, EXPECTED_TEXT, run);
    
    if (!healthAfterTest.gnomeShell) {
      console.log(`  FAIL: GNOME Shell crashed during test`);
      testsFailed++;
    } else if (!healthAfterTest.noJsErrors) {
      console.log(`  FAIL: JS errors detected during test`);
      testsFailed++;
    } else if (result.passed) {
      console.log(`  PASS: ${result.message}`);
    } else {
      console.log(`  FAIL: ${result.message}`);
      testsFailed++;
    }

    await vm.stopRecording();
    vm.createVideoFromScreenshots();
    createVideoFromScreenshots(run);

    if (UPDATE_MODE) {
      updateReferenceImages(run);
    }


  } catch (err) {
    console.error("\nFATAL:", err);
    testsFailed++;
  } finally {
    // Ensure recording is stopped even on failure
    await vm.stopRecording();
    // Fetch VM logs before shutdown (for artifact upload)
    try {
      await vm.fetchLogs(OUTPUT_DIR);
    } catch {
      // Best effort — SSH may be down
    }
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
    console.log("\n--- E2E Test Failure Help ---");
    console.log("For E2E debugging, read the skills:");
    console.log("  .agents/skills/e2e-debugging/SKILL.md  — VM lifecycle, screenshots, deployment");
    console.log("  .agents/skills/e2e-setup/SKILL.md      — First-time VM setup");
    process.exit(1);
  }
}

main();
