import { ensureParakeet } from "./lib/parakeet.js";
import { ParallelTestRunner, type TestCase } from "./lib/parallel.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { join } from "node:path";
import { StepRunner } from "./lib/step-runner.js";
import { VmManager, type VmConfig } from "./lib/vm.js";
import { RunContext } from "./lib/run-context.js";
import { deployTestAudio, deployExtension, startVoiceService } from "./lib/deploy-steps.js";
import { doAtspiAction, findAtspiExtents, waitForAtspiNode, waitForAtspiText } from "./lib/atspi.js";
import { pollForCommandOutput, pollFileExists } from "./lib/poll.js";
import { beginSpan, endSpan, printTimingTree } from "./lib/timing.js";
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
/** Detect timing-mode output lines (filtered from normal stdout). */
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
// --no-save-snapshot: restore an existing snapshot but never save/update it.
// Saving requires --save-snapshot (just e2e passes it); explicit opt-out wins.
const NO_SAVE_SNAPSHOT = args.includes("--no-save-snapshot");
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
const SKIP_PREFS_GATE = !TEST_PREFS && !args.includes("--no-skip-prefs");
// Anything whose change affects the prefs screenshots: rendered UI, deployed
// values (config fixture, dconf seeds), deploy pipeline.
const PREFS_SOURCES = [
  "gnome-ext/prefs.js",
  "gnome-ext/prefs",
  "gnome-ext/schemas",
  "gnome-ext/stylesheet.css",
  "gnome-ext/metadata.json",
  "gnome-ext/vendor/js-yaml.mjs",
  "e2e/fixtures/voice-to-text-config.yaml",
  "install.sh",
];

/**
 * Whether prefs screenshots should run. Compares the content hash of all
 * prefs-affecting files against the hash stored after the last run. On the
 * first run in a worktree (no stored hash) the decision comes from git diff
 * vs main instead, so a clean branch skips the screenshots immediately.
 */
function prefsUiChanged(): boolean {
  const { createHash } = require("node:crypto");
  const hash = createHash("sha256");
  for (const p of PREFS_SOURCES) {
    const abs = join(PROJECT_ROOT, p);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs).sort()) {
        hash.update(p + "/" + f + Bun.hash(readFileSync(join(abs, f))));
      }
    } else {
      hash.update(p + Bun.hash(readFileSync(abs)));
    }
  }
  const current = hash.digest("hex");
  const statePath = join(OUTPUT_DIR, ".prefs-ui-hash");
  let stored: string | null = null;
  try {
    stored = readFileSync(statePath, "utf-8").trim();
  } catch {
    // no state file = first run in this worktree
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(statePath, current);
  if (stored === null) {
    const diff = execSync(
      "git diff --name-only main...HEAD; git diff --name-only; git ls-files --others --exclude-standard",
      { cwd: PROJECT_ROOT, encoding: "utf-8" },
    );
    return diff.split("\n").some((f) => prefsSourceMatch(f.trim()));
  }
  return stored !== current;
}

/** Whether a changed path is a prefs source (file or inside a source dir). */
function prefsSourceMatch(file: string): boolean {
  if (!file) return false;
  return PREFS_SOURCES.some(
    (src) => file === src || (statSync(join(PROJECT_ROOT, src)).isDirectory() && file.startsWith(src + "/")),
  );
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
/** Lazy-loaded test matrix for parallel mode. */
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

/** Pick which fixture audio case this run transcribes. */
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

/** Fail fast when the VM base image is missing. */
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

/** Full single-VM test flow: terminal, recording, transcription, prefs screenshots. */
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

  beginSpan("capture-frame");
  await vm.captureFrame("01-desktop");
  endSpan();

  // Step 1: Dismiss Activities overview (D-Bus Set is idempotent)
  beginSpan("dismiss-activities");
  console.log("Dismissing Activities...");
  await shell.dismissActivities();
  const activitiesOpen = await shell.isActivitiesOpen();
  console.log(`  Activities after dismiss: ${activitiesOpen ? 'STILL OPEN' : 'closed'}`);
  await shell.waitActivitiesDismissed();
  endSpan();

  // Step 2: Open terminal with tmux inside (dotool needs a focused window)
  beginSpan("open-terminal");
  console.log("Opening terminal with tmux...");
  // Kill any stale tmux session from a previous run
  await tmux.killSession(tmuxCfg);
  const hasGhostty = (await shell.exec(`which ghostty 2>/dev/null`)).trim().length > 0;
  const spawnTerminal = () =>
    hasGhostty
      ? shell.exec(`nohup ghostty -e tmux new-session -s ${tmuxCfg.session} -x 120 -y 40 &>/dev/null &`)
      : shell.exec(`nohup gnome-terminal -- bash -c "tmux new-session -s ${tmuxCfg.session} -x 120 -y 40" &>/dev/null &`);
  await spawnTerminal();
  // Poll until tmux session appears (usually <1s; 5s is a generous ceiling).
  // If it never appears, the terminal emulator likely died on spawn — respawn
  // once before failing (flake: gnome-terminal sometimes crashes right after
  // snapshot restore under load).
  const waitTmux = () =>
    vm.pollUntil(
      "tmux session",
      async () => {
        try {
          const output = await shell.exec(`tmux list-sessions 2>/dev/null | grep ${tmuxCfg.session}`);
          return output.trim().length > 0;
        } catch {
          return false; // ssh hiccup — retry
        }
      },
      15000
    );
  try {
    await waitTmux();
  } catch {
    console.log("  tmux session did not appear — respawning terminal once");
    await tmux.killSession(tmuxCfg);
    await spawnTerminal();
    await waitTmux();
  }
  // Click on the terminal to ensure it has focus
  await shell.dotoolCommand("mousemove 640 400");
  await shell.dotoolCommand("buttondown 1");
  await shell.dotoolCommand("buttonup 1");
  // Verify terminal is focused by typing a test character and checking tmux.
  // Poll pane content instead of a fixed settle sleep — same signal, less waiting.
  const paneBefore = await tmux.capturePane(tmuxCfg);
  await shell.dotoolCommand("key shift+space"); // type space to confirm dotool works
  let paneAfter = "";
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(100);
    paneAfter = await tmux.capturePane(tmuxCfg);
    if (paneAfter !== paneBefore) break;
  }
  if (paneAfter === paneBefore) {
    // Terminal might not be focused, try clicking again
    console.log("  Retrying terminal focus...");
    await shell.dotoolCommand("mousemove 640 400");
    await shell.dotoolCommand("buttondown 1");
    await shell.dotoolCommand("buttonup 1");
    await Bun.sleep(300);
  }
  endSpan();

  beginSpan("capture-frame");
  await vm.captureFrame("02-tmux-started");
  endSpan();

  // Step 3: Snapshot pane content before recording (for transcription detection)
  beginSpan("snapshot-pane");
  const preRecordingPane = await tmux.capturePane(tmuxCfg);
  console.log("Pre-recording pane captured.");
  endSpan();

  beginSpan("capture-frame");
  await vm.captureFrame("03-pre-recording");
  endSpan();

  // Start screen recording now so the basic test AND the preferences window are both captured
  beginSpan("start-screencast");
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
  endSpan();

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
  beginSpan("start-recording");
  console.log("Starting recording via hotkey...");
  await shell.sendHotkey();
  await shell.waitForRecordingStart();
  endSpan();

  beginSpan("capture-frame");
  await vm.captureFrame("04-recording-started");
  endSpan();

  // Step 5: Wait for transcription (voice service types via dotool into tmux)
  beginSpan("transcription");
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
  endSpan();

  beginSpan("capture-frame");
  await vm.captureFrame("05-transcription-received");
  endSpan();

  // Step 6: Stop recording
  beginSpan("stop-recording");
  console.log("Stopping recording via hotkey...");
  await shell.sendHotkey();
  // Poll until recording state clears (sendHotkey is synchronous via D-Bus)
  await Bun.sleep(200); // Brief settle for D-Bus round-trip
  endSpan();

  // Basic test complete. Close the terminal so it doesn't appear in the preferences screenshots.
  console.log("Closing terminal before preferences tests...");
  await tmux.killSession(tmuxCfg);
  await shell.exec("pkill -f ghostty 2>/dev/null; true");
  // Poll until the terminal emulator has actually exited (no blind sleep).
  await vm.pollUntil(
    "terminal closed",
    async () => {
      try {
        // [g]hostty bracket trick: prevents pgrep from matching this very
        // ssh command's own cmdline (sh -c "...ghostty...").
        const out = await shell.exec("pgrep -f '[g]hostty'; true");
        return out.trim().length === 0;
      } catch {
        return false;
      }
    },
    5000
  );

  // Open preferences window (still inside the screen recording).
  beginSpan("preferences-screenshots");
  if (SKIP_PREFS_GATE && !prefsUiChanged()) {
    console.log("\n⏭  Prefs UI unchanged since last run — skipping preferences screenshots (use --no-skip-prefs to force)");
  } else {
    await runPreferencesTests(vm, run);
  }
  endSpan();

  // Stop screen recording
  beginSpan("stop-screencast");
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
  endSpan();

  beginSpan("capture-frame");
  await vm.captureFrame("06-recording-stopped");
  endSpan();

  // Step 7: Write result to file
  beginSpan("write-result");
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
  endSpan();

  // Cleanup: kill tmux session
  await tmux.killSession(tmuxCfg);

  // Retrieve screencast file from VM
  // Retrieve screencast file from VM
  if (screencastFile) {
    // Validate path: must be an absolute path, no traversal, ends with .webm
    if (!/^\/tmp\/e2e-screencast[^']*\.webm$/.test(screencastFile)) {
      console.log(`  Screencast file path rejected: ${screencastFile}`);
    } else {
      beginSpan("retrieve-screencast");
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
      endSpan();
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
async function captureScreenshot(label: string, run: RunContext, vm?: VmManager): Promise<string> {
  const testCase = getTestCaseName();
  const pngPath = getScreenshotPath(label, testCase, run.outputDir);
  const ppmPath = pngPath.replace(/\.png$/, ".ppm");
  
  // Ensure directory exists
  const dir = require("node:path").dirname(pngPath);
  require("node:fs").mkdirSync(dir, { recursive: true });
  
  try {
    // Use QemuMonitor (HMP over the monitor socket). The previous `nc -U
    // <socket> -w 2` approach silently fails with Fedora's nc — it exits 0
    // without connecting, so no PPM was ever produced and convert wrote
    // nothing — yet "Screenshot saved" was still logged.
    if (vm) {
      await vm.qemu.screendump(ppmPath);
    } else {
      execSync(
        `echo "screendump ${ppmPath}" | nc -U ${run.socketPath} -w 2`,
        { encoding: "utf-8", timeout: 5000 }
      );
    }
    // screendump is synchronous (monitor waits for the (qemu) prompt), but the file
    // write is async on QEMU's side — poll briefly as belt-and-suspenders
    await pollFileExists(ppmPath);
    // Convert PPM to PNG
    execSync(`convert ${ppmPath} ${pngPath} 2>/dev/null || true`, {
      encoding: "utf-8",
      timeout: 5000
    });
    // Clean up PPM
    execSync(`rm -f ${ppmPath}`, { encoding: "utf-8" });
    if (!existsSync(pngPath)) {
      console.log(`  Screenshot capture failed: screendump produced no PNG at ${pngPath}`);
      return "";
    }
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
  const screenshot = await captureScreenshot("05-transcription-received", run, vm);
  
  // Verify via file (primary method)
  const { stdout: actual } = await vm.deployer.exec("cat /tmp/file.txt 2>/dev/null");
  
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\.+$/, "").replace(/\s+/g, " ");
  const actualNorm = normalize(actual);
  const expectedNorm = normalize(expected);
  
  // Check text match
  if (actualNorm !== expectedNorm) {
    return { passed: false, message: `Text does not match: expected '${expectedNorm}', got '${actualNorm}'`, screenshot };
  }
  
  // Check visual regression (reference is mandatory unless --update populates it)
  const referencePath = getScreenshotPath("05-transcription-received", testCase, run.outputDir);
  if (UPDATE_MODE) {
    if (!existsSync(referencePath)) {
      console.log(`  No reference image yet (will be created by --update): ${referencePath}`);
    } else if (screenshot) {
      try {
        assertScreenshotMatches(referencePath, screenshot, run, "Visual regression");
      } catch (err) {
        return { passed: false, message: (err as Error).message, screenshot };
      }
    }
  } else if (!screenshot) {
    return { passed: false, message: "Screenshot capture failed — cannot run visual regression", screenshot };
  } else if (!existsSync(referencePath)) {
    return { passed: false, message: `No reference image for visual regression: ${referencePath} (run with --update to create)`, screenshot };
  } else {
    try {
      assertScreenshotMatches(referencePath, screenshot, run, "Visual regression");
    } catch (err) {
      return { passed: false, message: (err as Error).message, screenshot };
    }
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
 * Compare a captured screenshot against its reference.
 * Throws if MSE >= threshold or reference/capture missing.
 */
/**
 * Compare a captured screenshot against its reference using pixelmatch
 * (mapbox/pixelmatch — the standard screenshot-diff library, ~150 LOC, no deps).
 * Throws on missing reference/capture, size mismatch, or diff-pixel ratio >= 1%.
 */
function assertScreenshotMatches(referencePath: string, captured: string, run: RunContext, label: string): void {
  if (!existsSync(referencePath)) throw new Error(`No reference image for ${label}: ${referencePath} (run with --update to create)`);
  if (!captured || !existsSync(captured)) throw new Error(`${label} capture missing — cannot compare`);
  const imgRef = PNG.sync.read(readFileSync(referencePath));
  const imgAct = PNG.sync.read(readFileSync(captured));
  if (imgRef.width !== imgAct.width || imgRef.height !== imgAct.height) {
    throw new Error(`${label}: size mismatch — reference ${imgRef.width}x${imgRef.height} vs actual ${imgAct.width}x${imgAct.height}`);
  }
  const diff = new PNG({ width: imgRef.width, height: imgRef.height });
  const diffPixels = pixelmatch(imgRef.data, imgAct.data, diff.data, imgRef.width, imgRef.height, { threshold: 0.1 });
  const ratio = diffPixels / (imgRef.width * imgRef.height);
  const diffPath = join(run.outputDir, "test-cases", getTestCaseName(), `diff-${label}.png`);
  mkdirSync(require("node:path").dirname(diffPath), { recursive: true });
  writeFileSync(diffPath, PNG.sync.write(diff));
  if (ratio >= 0.01) {
    throw new Error(`${label}: diff-pixel ratio=${(ratio * 100).toFixed(3)}% (${diffPixels} px, threshold=1%), diff: ${diffPath}`);
  }
  console.log(`  ${label}: diff=${(ratio * 100).toFixed(3)}% (${diffPixels} px, pass)`);
}

/**
 * Compare a captured screenshot against its reference in expected-qemu/preferences/
 * using pixelmatch. Throws if diff-pixel ratio >= 1%. Skips (logs) when no
 * reference exists yet.
 */
async function compareWithReference(name: string, captured: string, run: RunContext): Promise<void> {
  const referencePath = join(CONFIG.paths.referencesDir, "preferences", `screenshot-${name}.png`);
  if (!existsSync(referencePath)) {
    console.log(`  No reference for ${name}: ${referencePath} (run with --update to create)`);
    return;
  }
  try {
    assertScreenshotMatches(referencePath, captured, run, name);
  } catch (err) {
    if (err instanceof Error && err.message.includes("diff-pixel ratio")) throw err;
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
  
  // GNOME 50's gnome-extensions client has no --gsettings flag; also the
  // dconf seed above only lands at deploy time. Belt-and-suspenders: set it
  // again right before prefs launches (idempotent).
  await vm.deployer.exec(
    `gsettings set org.gnome.desktop.interface toolkit-accessibility true`
  );

  // Open preferences window using gnome-extensions prefs command
  console.log("  Opening preferences window...");
  await vm.deployer.exec(
    `export DISPLAY=:0; export XDG_RUNTIME_DIR=/run/user/$(id -u); gnome-extensions prefs voice-to-text@happytomatoe.com &`
  );
  
  // Wait for the prefs window node to appear in the a11y tree
  await waitForAtspiNode(vm.deployer, { name: "Voice to Text", role: "frame" });
  console.log("  Prefs window visible (AT-SPI)");
  
  // Capture a prefs screenshot via QEMU monitor screendump (full display).
  // CodeRabbit suggested portal/Shell.Screenshot here, but Eval is disabled
  // in GNOME 50 and portal adds a permission dialog without window accuracy
  // gains — screendump was correct all along.
  const capturePrefs = async (name: string): Promise<string> => {
    const png = join(prefsDir, `${name}.png`);
    const ppm = join(prefsDir, `${name}.ppm`);
    await vm.qemu.screendump(ppm);
    await pollFileExists(ppm);
    execSync(`convert "${ppm}" "${png}" 2>/dev/null || true`, { encoding: "utf-8" });
    execSync(`rm -f "${ppm}"`, { encoding: "utf-8" });
    console.log(`  📷 Captured: ${name}.png`);
    return png;
  };

  // Take screenshot of main preferences window
  const mainPng = await capturePrefs("prefs-main");
  
  // Scroll to page bottom in one go, wait for the last row to show
  console.log("  Scrolling to bottom...");
  const addWordExt = await findAtspiExtents(vm.deployer, "Add Word…");
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); echo "mouseto ${(addWordExt.x + addWordExt.width / 2) / 1920} ${(addWordExt.y + addWordExt.height / 2) / 1080}\nwheel -50" | dotool`
  );
  await waitForAtspiNode(vm.deployer, { name: "Edit Configuration File", role: "list item" });
  
  const bottomPng = await capturePrefs("prefs-bottom");
  
  // Test adding a new word via the Add Word row
  console.log("  Testing Add Word functionality...");
  await doAtspiAction(vm.deployer, "Add Word…", "press");
  
  // The Add Word dialog exposes an entry — wait for it, set text via AT-SPI,
  // then click Add (button actions verified during recon)
  await waitForAtspiNode(vm.deployer, { name: "Enter a word or phrase:" });
  await vm.deployer.exec(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u); python3 - <<'ATSPIEOF'\nimport gi\ngi.require_version("Atspi","2.0")\nfrom gi.repository import Atspi\nd = Atspi.get_desktop(0)\ndef walk(node, depth=0):\n    if node is None or depth > 25: return None\n    try:\n        if (node.get_name() or "").strip() == "Enter a word or phrase:":\n            t = node.query_text()\n            t.set_text_contents("E2E")\n            return True\n    except Exception: pass\n    try: n = node.get_child_count()\n    except Exception: return None\n    for i in range(n):\n        if walk(node.get_child_at_index(i), depth+1): return True\n    return None\nfor i in range(d.get_child_count()):\n    if walk(d.get_child_at_index(i)): break\nATSPIEOF`
  );
  await waitForAtspiText(vm.deployer, "Enter a word or phrase:", "E2E");
  // Click the Add button
  await doAtspiAction(vm.deployer, "Add", "click");
  // Wait for the new word row to appear in the list
  await waitForAtspiNode(vm.deployer, { name: "E2E", role: "list item" });
  
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
    ["prefs-bottom", bottomPng],
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

/** Entry point: parse flags, boot VM, run flow or prefs tests. */
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
    
    if (SKIP_PREFS_GATE && !prefsUiChanged()) {
      console.log("\n⏭  Prefs UI unchanged — skipping preferences test run (use --no-skip-prefs to force)");
      process.exit(0);
    }
    await runPreferencesTests(vm, run);
  }
  try {
    if (SNAPSHOT_MODE) {
      // Snapshot mode: restore if exists, otherwise deploy and save
      // Check snapshot BEFORE boot — with -loadvm the guest resumes directly
      // from the snapshot instead of doing a full boot.
      beginSpan("preflight");
      await preflight();
      endSpan();
      const hasSnap = await vm.hasSnapshot("ready");
      let restored = false;
      
      if (hasSnap) {
        beginSpan("restore-snapshot");
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
        endSpan(!restored);
      }
      
      if (!restored) {
        beginSpan("deploy-and-save-snapshot");
        console.log("\n--- No snapshot restore, deploying fresh ---");
        await new StepRunner().run([
          { name: "boot-vm", fn: () => vm.boot(), timeout: 120_000 },
          { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 120_000 },
          { name: "setup", fn: () => vm.setup(), timeout: 600_000 },
          ...(NO_SAVE_SNAPSHOT
            ? []
            : [{ name: "save-snapshot", fn: () => vm.saveCleanSnapshot("ready") }]),
        ]);
        endSpan(); // deploy-and-save-snapshot
      } else {
        // Deploy test audio for this specific test case (snapshot has old audio)
        beginSpan("deploy-test-audio");
        deployTestAudio(vm.deployCfg);
        endSpan();
        // Snapshot restore resumes OLD guest state — always redeploy the
        // extension so the run executes CURRENT code (install.sh --local is
        // idempotent and cheap); otherwise any code change after the snapshot
        // save is invisible to e2e.
        beginSpan("deploy-extension");
        await deployExtension(vm.shell, vm.deployCfg, vm.pollUntil, vm.deployer);
        endSpan();
        beginSpan("start-voice-service");
        // The service process thawed from the snapshot is a zombie: its threads
        // do not survive -loadvm (bus name answers, transcription never runs).
        // Kill it and start a fresh one with current code + env, mirroring the
        // fresh-deploy path so a restored VM runs current code in EVERY
        // component, not just the extension. Reuses startVoiceService's own
        // kill+wait-for-bus-gone logic via skipDeps=true (deps already baked
        // into the snapshot).
        await startVoiceService(
          vm.shell, vm.deployCfg, vm.pollUntil,
          (exec, cmd, expected, timeoutMs) => pollForCommandOutput(exec, cmd, expected, timeoutMs),
          true,
        );
        endSpan(); // start-voice-service
      }
      
      // Run test
      beginSpan("test-flow");
      await runTestFlow(vm, run);
      const result = await verifyWithScreenshot(vm, EXPECTED_TEXT, run);
      endSpan(); // test-flow
      
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
    // Close any spans still open when the failure happened, so the tree shows
    // which phase died (and how long it hung before dying).
    printTimingTree();
  } finally {
    if (!KEEP_VM) {
      // Hard cap on shutdown: QEMU monitor / ssh2 teardown can hang forever on
      // a dead socket. Never let cleanup block the exit code.
    beginSpan("vm-shutdown");
      await Promise.race([
        vm.shutdown().catch((err) => console.log(`  shutdown warning: ${err instanceof Error ? err.message : err}`)),
        Bun.sleep(20000).then(() => console.log("  shutdown timed out after 20s — killing VM process")),
      ]);
      run.cleanup();
      endSpan(); // vm-shutdown
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
  printTimingTree();

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
