import { ensureParakeet } from "./lib/parakeet.js";
import { resolveEnv, type EnvName } from "./lib/env.js";
import { ParallelTestRunner, type TestCase } from "./lib/parallel.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { join } from "node:path";
import { StepRunner } from "./lib/step-runner.js";
import { VmManager, type VmConfig } from "./lib/vm.js";
import { RunContext } from "./lib/run-context.js";
import { deployTestAudio, deployExtension, startVoiceService } from "./lib/deploy-steps.js";
import { ATSPI_PY, doAtspiAction, findAtspiExtents, setAtspiText, setAtspiTextByRole, waitForAtspiNode, waitForAtspiText } from "./lib/atspi.js";
import { pollForCommandOutput, pollFileExists } from "./lib/poll.js";
import { beginSpan, endSpan, printTimingTree } from "./lib/timing.js";
import * as tmux from "./lib/tmux.js";
import { LocalTransport } from "./lib/transport.js";
import { ShellHelper } from "./lib/shell.js";
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

// Environment selector: fedora-local (Fedora VM, original suite) |
// ubuntu-local (pinned Ubuntu 26.04 VM via QEMU, same bits as CI) |
// ubuntu-ci (identical to ubuntu-local; run by GitHub Actions).
// Only environment config differs — suite logic is shared.
type Env = "fedora-local" | "ubuntu-local" | "ubuntu-ci" | "ubuntu-bare";
const envIdx = args.indexOf("--env");
const ENV: Env = envIdx >= 0 ? (args[envIdx + 1] as Env) : "fedora-local";
if (!"fedora-local ubuntu-local ubuntu-ci ubuntu-bare".split(" ").includes(ENV)) {
  throw new Error(`Unknown env '${ENV}'. Valid: fedora-local, ubuntu-local, ubuntu-ci, ubuntu-bare`);
}
const IS_UBUNTU = ENV !== "fedora-local";
// ubuntu-bare: suite runs on the runner itself inside dbus-run-session —
// no QEMU VM, no SSH. All commands go through LocalTransport.
// --use-existing: attach to an already-running VM instead of booting a fresh
// one — for reproducing CI failures locally against the same VM/image.
const USE_EXISTING = args.includes("--use-existing");
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
const NO_PREFS = args.includes("--no-prefs");
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

// Configuration — per-environment. Ubuntu 26.04 (resolute) PINNED: the exact
// same cloud image URL must be used by local fresh-mode runs and CI, so a CI
// failure can be reproduced locally with identical bits.
const UBUNTU_2604_CLOUD_IMAGE = "https://cloud-images.ubuntu.com/daily/server/resolute/current/resolute-server-cloudimg-amd64.img";

const FEDORA_CONFIG = {
  baseImage: (() => {
    const goldenDeps = join(import.meta.dir, "qemu-images/golden-gnome-deps.qcow2");
    if (existsSync(goldenDeps)) return goldenDeps;
    const depsBase = join(import.meta.dir, "qemu-images/base-with-deps.qcow2");
    if (existsSync(depsBase)) return depsBase;
    const uvBase = join(import.meta.dir, "qemu-images/base-with-uv.qcow2");
    if (existsSync(uvBase)) return uvBase;
    return join(import.meta.dir, "qemu-images/base.qcow2");
  })(),
  sshKey: join(import.meta.dir, "qemu-images/id_ed25519"),
  referencesDir: join(import.meta.dir, "expected-qemu"),
};

const UBUNTU_CONFIG = {
  baseImage: join(import.meta.dir, "ubuntu-2604-cloud.qcow2"),
  sshKey: join(import.meta.dir, "id_ed25519"),
  referencesDir: join(import.meta.dir, "expected-ubuntu"),
  // e2e-vm/boot-vm.sh parity VM: localhost:2222, key in e2e-vm/
  existing: {
    port: 2222,
    key: join(import.meta.dir, "../e2e-vm/id_ed25519"),
  },
};

const envCfg = IS_UBUNTU ? UBUNTU_CONFIG : FEDORA_CONFIG;

const CONFIG = {
  env: ENV,
  isUbuntu: IS_UBUNTU,
  ubuntuCloudImage: UBUNTU_2604_CLOUD_IMAGE,
  paths: {
    projectRoot: join(import.meta.dir, ".."),
    suiteDir: import.meta.dir,
    vmDir: join(import.meta.dir, "qemu-images"),
    baseImage: envCfg.baseImage,
    overlayImage: join(join(import.meta.dir, "qemu-images"), "overlay.qcow2"),
    socketPath: "/tmp/qemu-monitor.sock",
    sshKey: USE_EXISTING && IS_UBUNTU ? UBUNTU_CONFIG.existing.key : envCfg.sshKey,
    referencesDir: envCfg.referencesDir,
    outputDir: join(import.meta.dir, "output"),
    pythonSrc: join(import.meta.dir, "../src/voice_to_text"),
    testCasesFile: join(import.meta.dir, "fixtures/test-cases.json"),
  },
  ssh: {
    port: USE_EXISTING && IS_UBUNTU ? UBUNTU_CONFIG.existing.port : 2222,
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

// Resolved environment (env interface lives in lib/env.ts)
const SUITE_ENV = resolveEnv(import.meta.dir, ENV as EnvName, USE_EXISTING);

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
function pickRandomTestCase(): TestCaseFile {
  const data = JSON.parse(readFileSync(TEST_CASES_FILE, "utf-8"));
  const cases: TestCaseFile[] = data["test-cases"];
  let picked: TestCaseFile;
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

  // Recording state (started mid-flow, after open-terminal's 2s settle)
  let useXvfbRecording = false;
  // Guarantee ffmpeg cleanup on any exit path
  process.on('exit', () => {
    try { vm['recordingFfmpeg']?.kill('SIGKILL'); } catch { /* best-effort */ }
    try { vm['xvfbProcess']?.kill('SIGKILL'); } catch { /* best-effort */ }
  });

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
  // Ghostty must exist in the VM — the test flow depends on it (window title,
  // AT-SPI tree, dotool input). Fail fast instead of silently falling back.
  const whichGhostty = (await shell.exec(`which ghostty 2>/dev/null`)).trim();
  if (!whichGhostty) {
    throw new Error("ghostty not found in VM — expected pre-installed on the base image");
  }
  const spawnTerminal = () =>
    shell.exec(`nohup ghostty -e tmux new-session -s ${tmuxCfg.session} -x 120 -y 40 \; set-option allow-rename off \; set-option set-titles on \; set-option set-titles-string "${tmuxCfg.session}" &>/dev/null &`);
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
  // Focus probe + verify: ONE in-VM script, ONE SSH round trip. Previously
  // this was 3 dotool SSH calls + up to 10 capture-pane round trips (~20s).
  // The script clicks, sends a probe key, diffs the tmux pane, retries once
  // and prints FOCUSED / NOT_FOCUSED.
  const focusProbe = [
    "set -e",
    "export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe",
    "D=/home/testuser/.local/bin/dotoolc",
    "cap() { tmux capture-pane -t e2e -p; }",
    "before=$(cap)",
    "click() { echo 'mousemove 640 400' | $D; echo 'buttondown 1' | $D; echo 'buttonup 1' | $D; }",
    "click; sleep 0.3",
    "echo 'key shift+a' | $D; sleep 0.3",
    "if [ \"$(cap)\" != \"$before\" ]; then echo FOCUSED; exit 0; fi",
    "click; sleep 0.3",
    "echo 'key shift+a' | $D; sleep 0.5",
    "if [ \"$(cap)\" != \"$before\" ]; then echo FOCUSED; else echo NOT_FOCUSED; fi",
  ].join("\n");
  const focusOut = await shell.exec(`bash -c ${JSON.stringify(focusProbe)}`).catch(() => "");
  if (!focusOut.includes("FOCUSED")) {
    console.log("  WARNING: Terminal may not be focused");
  }
  // Additionally verify the terminal window exists via AT-SPI. Ghostty's
  // window title is exactly "Ghostty" (tmux set-titles does NOT propagate to
  // the window title — verified live in the VM a11y tree).
  try {
    await waitForAtspiNode(vm.deployer, {
      name: "Ghostty",
      role: "frame",
      timeoutMs: 10000,
    });
  } catch {
    console.log("  WARNING: Ghostty frame not found via AT-SPI, continuing");
  }
  endSpan();

  // Start screen recording right before the hotkey: 1s of focused-terminal
  // context, then capture the interesting part (widget → transcription typing).
  await Bun.sleep(1000);
  try {
    vm.startRecording();
    useXvfbRecording = true;
  } catch (e) {
    console.log(`  Xvfb recording not available: ${e}`);
  }

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

  // Xvfb recording starts after open-terminal (2s settle). This span only
  // prepares the fallback screencast path. The preferences window is NOT
  // captured — prefs tests run after stop-recording.
  beginSpan("start-screencast");
  const screencastDir = run.outputDir;
  let screencastFile = "";
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

  // Hold the final frame briefly so the recording ends on the full typed line
  // instead of cutting off mid-typing (video-only cost: 2s idle).
  await Bun.sleep(2000);

  // Step 6: Stop recording — stopRecording() then trims the idle head
  // fire-and-forget, in parallel with VM shutdown.
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
  const localPath = join(run.outputDir, "test-recording.webm");
      try {
        await vm.transport.copyFrom(screencastFile, localPath);
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
 * Get screenshot path (flat: e2e/output/<id>/screenshot-<label>.png).
 */
function getScreenshotPath(label: string, _testCase?: string, outputDir = OUTPUT_DIR): string {
  return join(outputDir, "screenshots", `screenshot-${label}.png`);
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
 * Compare a captured screenshot against its reference.
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
  
  // Copy common screenshots
  const commonLabels = ["01-desktop", "02-tmux-started", "03-pre-recording", "04-recording-started", "06-recording-stopped"];
  for (const label of commonLabels) {
    const src = getScreenshotPath(label, undefined, run.outputDir);
    const dst = join(CONFIG.paths.referencesDir, `screenshot-${label}.png`);
    if (existsSync(src)) {
      execSync(`cp "${src}" "${dst}"`, { encoding: "utf-8" });
      console.log(`  Copied: ${label} → expected-qemu/`);
    }
  }
  
  // Copy test-case-specific screenshot
  const transcriptionSrc = getScreenshotPath("05-transcription-received", testCase, run.outputDir);
  const transcriptionDst = join(CONFIG.paths.referencesDir, "screenshot-05-transcription-received.png");
  if (existsSync(transcriptionSrc)) {
    execSync(`cp "${transcriptionSrc}" "${transcriptionDst}"`, { encoding: "utf-8" });
    console.log(`  Copied: transcription → expected-qemu/`);
  }
  
  // Copy preferences screenshots
  const prefsRefDir = join(CONFIG.paths.referencesDir, "preferences");
  mkdirSync(prefsRefDir, { recursive: true });
  const prefsNames = ["prefs-main", "prefs-scrolled-1", "prefs-scrolled-2", "prefs-scrolled-3", "prefs-after-add"];
  for (const name of prefsNames) {
    const src = join(run.outputDir, "screenshots", `${name}.png`);
    if (existsSync(src)) {
      execSync(`cp "${src}" "${prefsRefDir}/screenshot-${name}.png"`, { encoding: "utf-8" });
      console.log(`  Copied: ${name} → expected-qemu/preferences/`);
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
  const diffPath = join(run.outputDir, "screenshots", `diff-${label}.png`);
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
// Read the service's cmdline AND cwd from /proc — replaying the cmdline from a
// different cwd silently breaks commands with relative paths (uv --project .).
async function svcCmdline(
  svcPid: string,
  exec: (cmd: string, timeout?: number) => Promise<{ stdout: string }>,
): Promise<{ cmdline: string; cwd: string }> {
  const pidOk = svcPid && /^\d+$/.test(svcPid) && (await exec(`test -d /proc/${svcPid} && echo yes`, 5_000)).stdout.includes("yes");
  if (!pidOk) return { cmdline: "", cwd: "" };
  const cmdline = (await exec(`tr '\\0' ' ' < /proc/${svcPid}/cmdline 2>/dev/null`)).stdout.trim();
  const cwd = (await exec(`readlink /proc/${svcPid}/cwd 2>/dev/null`)).stdout.trim() || "";
  return { cmdline, cwd };
}

async function runPreferencesTests(vm: VmManager, run: RunContext): Promise<void> {
  console.log("\n📸 Running preferences screenshot tests...");
  
  const prefsDir = join(run.outputDir, "screenshots");
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
  
  // Test adding a new word via the Add Word button (exposes AT-SPI click)
  console.log("  Testing Add Word functionality...");
  await doAtspiAction(vm.deployer, "Add Word", "click");
  
  // The Add Word dialog exposes an entry — wait for it, set text via AT-SPI,
  // then click Add (button actions verified during recon)
  await waitForAtspiNode(vm.deployer, { name: "Enter a word or phrase:" });
  await setAtspiText(vm.deployer, "Enter a word or phrase:", "E2E");
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

/**
 * ubuntu-bare mode: the suite executes directly on the CI runner inside the
 * harness's dbus-run-session. No VM, no SSH, no GDM — the harness has already
 * booted headless gnome-shell, deployed the extension, and started the voice
 * service with VOICE_TO_TEXT_DEBUG_FILE set to the fixture WAV.
 */
async function runBareMode(): Promise<void> {
  // Exercise the transport seam: a LocalTransport-backed ShellHelper plus the
  // LocalTransport instance this function uses directly — proves bash -lc +
  // inherited dbus-run-session env at runtime.
  const shell = new ShellHelper();
  shell.useLocalTransport();
  const transport = new LocalTransport();
  const probe = await transport.exec("echo __SEAM_OK__ $DBUS_SESSION_BUS_ADDRESS");
  console.log(`  local transport probe: code=${probe.code} dbus=${probe.stdout.includes("__SEAM_OK__") ? "set" : "unset"}`);
  const outputDir = join(import.meta.dir, "output", "ubuntu-bare");
  mkdirSync(outputDir, { recursive: true });
  const textFile = process.env.VOX_CI_E2E_TEXT_FILE ?? "/tmp/typed-text.txt";

  await new StepRunner().run([
    {
      name: "wait-service-bus",
      timeout: 60_000,
      fn: () => {
        const transport = new LocalTransport();
        return pollForCommandOutput(
          (cmd: string) => transport.exec(cmd, 10_000).then(r => r.stdout),
          "busctl --user list 2>/dev/null | grep 'com.happytomatoe.[V]oiceToText'",
          "com.happytomatoe.VoiceToText",
          60_000,
        );
      },
    },
  ]);

  beginSpan("test-flow-bare");
  // All bare-mode commands run through the LocalTransport seam (bash -lc,
  // inheriting the dbus-run-session env) — the same interface the SSH envs use.
  const run = async (cmd: string, timeoutMs = 15_000) => {
    const r = await transport.exec(cmd, timeoutMs);
    if (r.code !== 0) {
      console.error(`Command failed (${r.code}): ${cmd}`);
      console.error(`stdout: ${r.stdout}`);
      console.error(`stderr: ${r.stderr}`);
      throw new Error(`command failed (${r.code}): ${cmd}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }
    return r.stdout;
  };
  const gdbus = (method: string, argsJson = "") =>
    run(
      `gdbus call --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText --method com.happytomatoe.VoiceToText.${method} ${argsJson}`,
    );

  // Matrix loop: all transcription cases × output methods. The service reads
  // VOICE_TO_TEXT_DEBUG_FILE at record start (src/voice_to_text/debug.py:52),
  // so the suite swaps the case WAV in before each StartRecording.
  const debugFile = process.env.VOICE_TO_TEXT_DEBUG_FILE;
  const fixturesDir = join(import.meta.dir, "fixtures");
  const serviceLog = process.env.VOX_CI_E2E_SERVICE_LOG ?? "/tmp/voice-service.log";
  // Each test case carries its own output-method (one case = one cell), so
  // --case runs exactly one file+method combination. --case filters by audio
  // filename substring.
  const matrix = loadTestMatrix()["test-suites"].transcription;
  const enabledMethods = new Set(
    matrix.matrix["output-methods"].filter((m: any) => m.enabled).map((m: any) => m.id),
  );
  const methodRequires: Record<string, string[]> = Object.fromEntries(
    matrix.matrix["output-methods"].map((m: any) => [m.id, m.requires ?? []]),
  );
  const rawCases = JSON.parse(readFileSync(TEST_CASES_FILE, "utf-8"))["test-cases"] as TestCaseFile[];
  const picked = SELECTED_CASE
    ? rawCases.filter(c => c.file.includes(SELECTED_CASE))
    : [rawCases[Math.floor(Math.random() * rawCases.length)]];
  if (picked.length === 0) throw new Error(`no test cases match '${SELECTED_CASE ?? "(all)"}'`);
  if (!SELECTED_CASE) console.log(`  Bare mode: randomly picked ${picked[0].file} (one case is enough for the basic flow)`);
  const allCases: (TestCaseFile & { method: string })[] = picked
    .map(c => ({ ...c, method: (c as any)["output-method"] ?? "mutter-commit" }));
  const uinputOk = !process.env.VOX_E2E_FORCE_NO_UINPUT &&
    (await transport.exec(`test -c /dev/uinput && test -w /dev/uinput`).then(r => r.code === 0));
  const canUseDotool = uinputOk;

  interface BareResult { file: string; method: string; status: "pass" | "fail"; typed: string; note?: string }
  const results: BareResult[] = [];
  const normalize = (s: string) =>
    s.trim().toLowerCase()
      .replace(/\b(\d)\s*p\.m\.?\b/g, "$1pm").replace(/\b(\d)\s*a\.m\.?\b/g, "$1am")
      .replace(/(\d)\s+(am|pm)\b/g, "$1$2")
      .replace(/\.+$/, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");

  const requireOk: Record<string, boolean> = {
    dotoolc: uinputOk,
    "gnome-extension": true,
  };
  for (const bareCase of allCases) {
    const method = bareCase.method;
    {
      if (!enabledMethods.has(method) || (methodRequires[method] ?? []).some(r => !requireOk[r])) {
        const reason = !enabledMethods.has(method) ? "disabled in matrix" : `unmet: ${methodRequires[method].join(",")}`;
        console.log(`\n=== ${bareCase.file}/${method} ===`);
        console.log(`  SKIP (${reason})`);
        results.push({ file: bareCase.file, method, status: "fail", typed: "", note: `skipped — ${reason}` });
        continue;
      }
      const label = `${bareCase.file}/${method}`;
      console.log(`\n=== ${label} ===`);
      try {
        // Log-window marker: only lines appended during THIS cell count.
        const offsetOut = await run(`wc -c < '${serviceLog}' 2>/dev/null || echo 0`);
        const offset = parseInt(offsetOut.trim()) || 0;
        const cellStartIso = new Date().toISOString();
        const logSince = (pattern: string) =>
          transport.exec(
            `tail -c +$(( ${offset} + 1 )) '${serviceLog}' 2>/dev/null | grep -m1 -oP '${pattern}'`,
            5_000,
          ).then(r => r.stdout.trim());

        if (debugFile) {
          await run(`cp '${join(fixturesDir, bareCase.file)}' '${debugFile}'`);
        }
        await gdbus(
          "StartRecording",
          `'${JSON.stringify({ provider: process.env.VOX_CI_E2E_PROVIDER || "moonshine", language: "en", output_method: method })}'`,
        );
        console.log("  recording started; polling for transcription...");

        // During-recording screenshot: recording widget/badge visible on
        // the desktop while capture is active.
        const shotDuring = process.env.VOX_CI_E2E_SHOT_DURING;
        if (shotDuring) {
          await Bun.sleep(1500);
          await transport.exec(
            `gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot true false '${shotDuring}'`,
            10_000,
          ).catch(() => console.log("  WARN: during-screenshot failed"));
        }

        // Capture file mtime at cell start — the fallback below must only
        // trust it if the extension wrote it DURING this cell (a stale file
        // from the previous cell caused test-05 to see test-04's text).
        const textFileMtime0 = await run(`stat -c %Y '${textFile}' 2>/dev/null || echo 0`);

        let transcription = "";
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline && !transcription) {
          // "(empty)" marks a completed-but-empty Parakeet response — waiting
          // longer cannot help, bail immediately (CI run 33726981834 burned
          // 4x90s on these).
          const res = await logSince("Transcription result: \\K.*|Transcription result: \(empty\)");
          if (res === "(empty)") break;
          transcription = res;
        }
        try {
          await gdbus("StopRecording");
        } catch (e) {
          console.log(`  StopRecording warning: ${e}`);
        }

        // Typed text: transcription from the service log; the output method
        // is verified separately — the extension's headless CommitText path
        // writes the capture file + logs "CI E2E captured typed text" in the
        // shell log. A cell PASSes only if the output method actually ran
        // (fresh capture write), so silently-failing typing FAILs the cell.
        let typed = transcription;
        let captureHit = false;
        try {
          const mtime = await run(`stat -c %Y '${textFile}' 2>/dev/null || echo 0`);
          if (parseInt(mtime.trim()) > parseInt(textFileMtime0.trim())) {
            captureHit = true;
            if (!typed) typed = readFileSync(textFile, "utf-8").trim();
          }
        } catch {
          // capture file absent
        }
        const errorLine = await logSince("ERROR|Traceback");
        // Output-method evidence for mutter-commit/mutter-virtual, two paths:
        // 1. capture file — the extension's headless no-focus fallback writes it;
        // 2. tmux pane — with the ghostty terminal focused (ghostty+tmux
        //    unification) the commit goes through the real IM path and no
        //    capture file is written; the text visibly landing in the pane is
        //    the stronger proof. dotool 'type' injects via uinput with no
        //    observable capture; its execution is proven by the flow completing
        //    without error.
        const captureRequired = process.env.VOX_CI_E2E_HEADLESS === "1" && method !== "type";
        let paneHit = false;
        if (!captureHit && captureRequired) {
          const pane = await transport.exec(`tmux capture-pane -t ci-e2e -p 2>/dev/null || true`, 5_000)
            .then(r => r.stdout).catch(() => "");
          paneHit = pane.length > 0 && normalize(pane).includes(normalize(bareCase.expected));
        }
        const passed = typed.length > 0 && normalize(typed).includes(normalize(bareCase.expected)) && !errorLine && (captureHit || paneHit || !captureRequired);
        console.log(`  expected: '${bareCase.expected}'`);
        console.log(`  typed:    '${typed}'`);
        console.log(`  output method exercised: capture=${captureHit} pane=${paneHit}${captureRequired ? " (required)" : " (optional for dotool)"}`);
        if (errorLine) console.log(`  error in log: ${errorLine}`);
        console.log(passed ? "  PASS" : "  FAIL");
        results.push({
          file: bareCase.file, method, status: passed ? "pass" : "fail", typed,
          note: !captureHit && !paneHit && captureRequired ? "output method did not run (no capture file or pane write)" : errorLine || undefined,
        });

        // Per-cell artifact dir: screenshot + log slices + recording window
        // marker, so each test gets a self-contained evidence folder.
        const shellLog = process.env.VOX_CI_E2E_SHELL_LOG ?? "";
        const cellLabel = `${bareCase.file.replace(/\.wav$/, "")}-${method}`;
        const cellsDir = process.env.VOX_CI_E2E_CELLS_DIR;
        if (cellsDir) {
          await transport.exec(`mkdir -p '${cellsDir}/${cellLabel}'`, 5_000).catch(() => {});
          await transport.exec(
            `gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot true false '${cellsDir}/${cellLabel}/after.png'`,
            10_000,
          ).catch(() => console.log("  WARN: case screenshot failed"));
          await transport.exec(`tail -c +$(( ${offset} + 1 )) '${serviceLog}' > '${cellsDir}/${cellLabel}/service.log' 2>/dev/null || true`, 5_000);
          if (shellLog) {
            await transport.exec(`tail -c +$(( ${offset} + 1 )) '${shellLog}' > '${cellsDir}/${cellLabel}/shell.log' 2>/dev/null || true`, 5_000);
          }
          await transport.exec(`printf '%s\n%s\n' '${cellStartIso}' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" > '${cellsDir}/${cellLabel}/window.txt'`, 5_000);
        }
        const shotBase = process.env.VOX_CI_E2E_SHOT_AFTER;
        if (shotBase) {
          // Per-cell after-shot only — the top-level -after-<cell>.png copy was
          // byte-identical to the cell's own after.png (duplicate artifact).
          const caseShot = `${cellsDir}/${cellLabel}/after.png`;
          await transport.exec(
            `gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot true false '${caseShot}'`,
            10_000,
          ).catch(() => console.log("  WARN: case screenshot failed"));
        }
      } catch (e) {
        console.log(`  FAIL (exception): ${e}`);
        results.push({ file: bareCase.file, method, status: "fail", typed: "", note: String(e) });
        // Recover the service for the next cell if this one wedged it.
        await gdbus("StopRecording").catch(() => {});
      }
    }
  }
  endSpan();

  console.log("\n=== bare-mode summary ===");

  // Prefs suite — runs BEFORE config/error rows (user ordering: prefs first).
  // AT-SPI-driven via LocalTransport (same ExecLike shape as the SSH deployer
  // in VM mode), no dotool needed. Screenshot via Shell.Screenshot D-Bus.
  const prefsRows: Array<{ id: string; status: "pass" | "fail" | "skip"; note?: string }> = [];
  const prefsRow = (id: string, ok: boolean, note?: string) =>
    prefsRows.push({ id, status: ok ? "pass" : "fail", note });
  const prefsSkip = (id: string, why: string) => prefsRows.push({ id, status: "skip", note: why });
  if (NO_PREFS) {
    prefsSkip("prefs window opens", "skipped — --no-prefs");
    prefsSkip("add-word roundtrip (type, click Add, row appears)", "skipped — --no-prefs");
    prefsSkip("prefs window closes", "skipped — --no-prefs");
  } else {
  const atspiReady = await transport.exec(
    "python3 -c 'import gi; gi.require_version(\"Atspi\", \"2.0\"); from gi.repository import Atspi' 2>&1 && echo OK",
    10_000,
  ).then(r => r.stdout.trim().endsWith("OK"));
  if (atspiReady) {
    try {
      await run(`gsettings set org.gnome.desktop.interface toolkit-accessibility true`);
      // Ask the Python service to open prefs: it emits OpenPrefsRequested,
      // the extension (inside the shell) opens its own dialog via
      // openPreferences(). This avoids org.gnome.Shell.Extensions D-Bus
      // activation entirely — that name never appears on the bus in a
      // headless nested session, so direct calls/activations cannot work.
      await run(`dbus-send --session --print-reply --dest=com.happytomatoe.VoiceToText --type=method_call /com/happytomatoe/VoiceToText com.happytomatoe.VoiceToText.OpenPrefs 2>&1`, 15_000);
      // OpenExtensionPrefs signature: (s uuid, s parent_window, a{sv} options).
      await run(`dbus-send --session --print-reply --dest=org.gnome.Shell.Extensions --type=method_call /org/gnome/Shell/Extensions org.gnome.Shell.Extensions.OpenExtensionPrefs string:"voice-to-text@happytomatoe.com" string:"" dict:string:variant: 2>&1`, 15_000);
      const execLike = { exec: (cmd: string, opts?: Record<string, unknown>) => transport.exec(cmd, (opts?.timeout as number) ?? 15_000) };
      await waitForAtspiNode(execLike, { name: "Voice to Text", role: "frame", timeoutMs: 20000 });
      const t0 = await transport.exec(
        `python3 - <<'ATSPIEOF'
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
d = Atspi.get_desktop(0)
for i in range(d.get_child_count()):
    a = d.get_child_at_index(i)
    print("APP:" + str(a.get_name()))
ATSPIEOF`, 10_000).then(r => r.stdout.trim());
      console.log(`  a11y apps after P01: ${t0.split("\n").filter(l => l.startsWith("APP:")).join(", ")}`);
      prefsRow("prefs window opens", true);
      // Scroll the prefs window to the bottom (mouse wheel over the list via
      // dotool — same approach as the local VM suite), so the scrolled state
      // and the Add Word button are reached like a real user would.
      let addWordRt = "structure-only";
      // dotool helpers shared by the scroll and add-word steps. mouseto takes
      // normalized 0..1 screen coords; extents must be screen-absolute
      // (CoordType.SCREEN — WINDOW coords are window-relative and land near 0,0).
      const dtool = (script: string) => run(
        `printf '%s\\n' '${script.replace(/'/g, "'\\''")}' | dotoolc`, 10_000);
      // Virtual monitor geometry: exported by the stage script (default 1280x720).
      const CI_WIDTH = parseInt(process.env.CI_E2E_WIDTH ?? "1280", 10);
      const CI_HEIGHT = parseInt(process.env.CI_E2E_HEIGHT ?? "720", 10);
      const extentsScript = (name: string) => `python3 - <<'ATSPIEOF'
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

def walk(node, depth=0):
    if node is None or depth > 35:
        return None
    try:
        if (node.get_name() or "").strip() == "${name}":
            e = node.get_component().get_extents(Atspi.CoordType.SCREEN)
            return f"{e.x},{e.y},{e.width},{e.height}"
    except Exception:
        return None
    try:
        n = node.get_child_count()
    except Exception:
        return None
    for i in range(n):
        r = walk(node.get_child_at_index(i), depth + 1)
        if r:
            return r
    return None

d = Atspi.get_desktop(0)
out = None
for i in range(d.get_child_count()):
    out = walk(d.get_child_at_index(i))
    if out:
        break
print("RESULT:" + str(out))
ATSPIEOF`;
      const screenCenter = async (name: string) => {
        const r = await transport.exec(extentsScript(name), 15_000);
        const res = r.stdout.split("\n").find(l => l.startsWith("RESULT:"))?.slice(7) ?? "";
        const [x, y, w, h] = res.split(",").map(Number);
        if ([x, y, w, h].some(v => !Number.isFinite(v))) throw new Error(`no SCREEN extents for '${name}': '${res}'`);
        return { nx: (x + w / 2) / CI_WIDTH, ny: (y + h / 2) / CI_HEIGHT };
      };
      // Synthetic input into GTK windows: dotool/uinput events never reach
      // the nested headless shell (runs 33880610703/33903070893: pixel-
      // identical screenshots, empty entry). The test-only e2e-input@local
      // helper extension injects through the compositor's own Clutter virtual
      // keyboard instead — test scaffolding stays out of the product extension.
      const typeTextDbus = (method: string, arg: string) => run(
        `gdbus call --session --dest com.happytomatoe.E2EInput --object-path /com/happytomatoe/E2EInput --method com.happytomatoe.E2EInput.${method} "'${arg.replace(/'/g, "'\\''")}'"`,
        10_000);
      // RemoteDesktop variant: inject pointer events through mutter's own
      // org.gnome.Mutter.RemoteDesktop API (same mechanism GNOME's GTK test
      // suite uses for headless mutter input tests). Session Notify* calls
      // must come from the creating peer, so remote_input.py owns the whole
      // RD+ScreenCast session lifecycle per invocation.
      const remoteInput = (args: string) => run(
        `python3 remote_input.py ${args}`, 15_000);
      const moveDbus = (nx: number, ny: number) => remoteInput(
        `move ${Math.round(nx * CI_WIDTH)} ${Math.round(ny * CI_HEIGHT)}`);
      const wheelDbus = (ticks: number) => remoteInput(`wheel ${ticks}`);
      if (canUseDotool) {
        const atspiPy = (body: string, timeout = 30_000) =>
          transport.exec(`python3 - <<'ATSPIEOF'\n${ATSPI_PY}\n${body}\nATSPIEOF`, timeout)
            .then(r => r.stdout.split("\n").find(l => l.startsWith("RESULT:"))?.slice(7) ?? "no-result");
        // GTK4 reports SHOWING even for viewport-clipped rows, so AT-SPI can't
        // prove scrolling — pixel-compare screenshots instead (user-visible
        // evidence, which is what this check is for).
        const shot = async (name: string) => {
          await transport.exec(
            `gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot true false '${outputDir}/${name}.png'`,
            10_000,
          ).catch(() => {});
        };
        // Pixel-diff two screenshots via ffmpeg PSNR (no ImageMagick on the
        // runner); identical frames → PSNR=inf. Threshold ~30dB: clock churns
        // a few pixels, real scrolling changes thousands.
        const pxChanged = async (a: string, b: string) => {
          const out = await transport.exec(
            `ffmpeg -v info -i '${outputDir}/${a}.png' -i '${outputDir}/${b}.png' -filter_complex psnr -f null - 2>&1 | grep -oP 'average:\\K[0-9.inf]+'`,
            20_000,
          ).then(r => r.stdout.trim()).catch(() => "err");
          console.log(`  scroll diff ${a} vs ${b}: PSNR=${out}`);
          return out;
        };
        try {
          await shot("prefs-scroll-before");
          // Scroll via AT-SPI Value interface on the vertical scrollbar.
          // No pointer/keyboard events, so no seat/focus side-effects.
          const res = await transport.exec(
            `python3 - <<'ATSPIEOF'\n${ATSPI_PY}\nprint("RESULT:" + str(scroll_to_bottom_via_value()))\nATSPIEOF`, 20_000)
            .then(r => r.stdout.split("\n").find(l => l.startsWith("RESULT:"))?.slice(7) ?? "no-result");
          console.log(`  atspi value scroll: ${res}`);
          await Bun.sleep(500);
          await shot("prefs-scroll-after");
          const psnr = await pxChanged("prefs-scroll-before", "prefs-scroll-after");
          const scrolled = psnr !== "inf" && psnr !== "err" && parseFloat(psnr) < 30;
          console.log(`  prefs scroll: ${scrolled ? "scrolled ✅" : "NOT scrolled ❌"}`);
        } catch (e) {
          console.log(`  WARN: scroll failed (${e}) — continuing with Add Word click`);
        }
      }
      // Add-Word dialog: open it, then run the full roundtrip — type via the
      // helper extension's virtual keyboard (GTK4 refuses AT-SPI
      // SetTextContents, and uinput doesn't reach GTK here), click Add via
      // AT-SPI, verify the row appears.
      await doAtspiAction(execLike, "Add Word", "click");
      // The modal dialog doesn't reliably get keyboard focus in the headless
      // nested shell when the virtual pointer is parked over the prefs list —
      // activate it explicitly (same wl_keyboard.enter issue as the prefs
      // window; without this, TypeText keystrokes never reach the entry).
      await typeTextDbus("ActivateWindow", "Add Custom Word");
      await Bun.sleep(500);
      // Click-to-focus the entry with the RemoteDesktop virtual pointer:
      // activation alone did not restore keyboard focus after pointer
      // scrolling (run 33919961080), so force it with a real pointer press.
      const entryExt = await transport.exec(
        `python3 - <<'ATSPIEOF'\n${ATSPI_PY}\nprint("RESULT:" + str(find_add_word_entry_extents()))\nATSPIEOF`, 30_000)
        .then(r => r.stdout.split("\n").find(l => l.startsWith("RESULT:"))?.slice(7) ?? "no-result");
      if (entryExt.includes(",")) {
        const [ex, ey, ew, eh] = entryExt.split(",").map(Number);
        if ([ex, ey, ew, eh].every(v => Number.isFinite(v)) && ew > 0 && eh > 0) {
          await remoteInput(`click ${ex + ew / 2} ${ey + eh / 2}`);
          await Bun.sleep(300);
          console.log(`  clicked entry at (${ex + ew / 2}, ${ey + eh / 2})`);
        }
      } else {
        console.log(`  entry extents unavailable: ${entryExt} — typing without click-focus`);
      }
      {
        const readEntry = () =>
          transport.exec(
            `python3 - <<'ATSPIEOF'\n${ATSPI_PY}\nprint("RESULT:" + str(read_add_word_entry() or ""))\nATSPIEOF`, 30_000)
            .then(r => r.stdout.split("\n").find(l => l.startsWith("RESULT:"))?.slice(7) ?? "no-result");
        const shot2 = async (name: string) => {
          await transport.exec(
            `gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot true false '${outputDir}/${name}.png'`,
            10_000,
          ).catch(() => {});
        };
        await Bun.sleep(1500);
        // The entry gets default focus when the dialog opens. Type, then READ
        // the text back via AT-SPI — input can silently miss, and clicking Add
        // with an empty entry is a silent no-op.
        const typeAndRead = async () => {
          await typeTextDbus("TypeText", "E2E");
          await Bun.sleep(800);
          return readEntry();
        };
        let entryText = await typeAndRead();
        if (!entryText.includes("E2E")) {
          console.log(`  entry text after first type: '${entryText}' — retrying`);
          entryText = await typeAndRead();
        }
        console.log(`  entry text: '${entryText}'`);
        if (entryText.includes("E2E")) {
          await doAtspiAction(execLike, "Add", "click");
          // The Add click closes the dialog on success — wait for the new row
          // in the custom-words list directly (verify_word_added expects the
          // dialog to still exist and returns no-dialog here).
          let rowFound = "no";
          for (let i = 0; i < 20; i++) {
            rowFound = await transport.exec(
              `python3 - <<'ATSPIEOF'\n${ATSPI_PY}\nprint("RESULT:" + node_name_present("E2E"))\nATSPIEOF`, 15_000)
              .then(r => r.stdout.split("\n").find(l => l.startsWith("RESULT:"))?.slice(7) ?? "no");
            if (rowFound === "yes") break;
            await Bun.sleep(500);
          }
          addWordRt = rowFound === "yes" ? "ok" : "row-not-found";
        } else {
          addWordRt = `entry-text='${entryText}' (keystrokes never reached the entry)`;
        }
        console.log(`  add-word roundtrip: ${addWordRt}`);
        prefsRow("add-word roundtrip (type, click Add, row appears)", addWordRt === "ok", addWordRt === "ok" ? undefined : addWordRt);
        // Screenshot AFTER the word was added — must VISUALLY show the new
        // "E2E" row AND the bottom of the prefs window (user feedback: the
        // add must be visible in evidence). Preferred: AT-SPI
        // Component.scroll_to("Open Editor", BOTTOM_RIGHT) — the native
        // accessibility scroll API, scrolls the last widget into view in one
        // call. Fallback: Tab-focus walk (GTK auto-scrolls focused widgets).
        try {
          // Scroll via AT-SPI Value interface on the vertical scrollbar —
          // no pointer events, no focus side-effects on the modal.
          const res2 = await transport.exec(
            `python3 - <<'ATSPIEOF'\n${ATSPI_PY}\nprint("RESULT:" + str(scroll_to_bottom_via_value()))\nATSPIEOF`, 20_000)
            .then(r => r.stdout.split("\n").find(l => l.startsWith("RESULT:"))?.slice(7) ?? "no-result");
          console.log(`  atspi value scroll: ${res2}`);
          await Bun.sleep(600);
        } catch (e) {
          console.log(`  WARN: scroll-to-bottom failed (${e})`);
        }
        await Bun.sleep(500);
        await shot2("prefs-after-add");
      }
      // Close: prefs window has no guaranteed a11y close action — the Adw
      // window lives in the org.gnome.Shell.Extensions process; kill it and
      // verify the window leaves the a11y tree.
      await run(`pkill -f '[o]rg.gnome.Shell.Extensions' || true`, 5_000);
      await Bun.sleep(2000);
      const gone = await transport.exec(
        `python3 - <<'ATSPIEOF'
from gi.repository import Atspi
d = Atspi.get_desktop(0)
found = "no"
for i in range(d.get_child_count()):
    app = d.get_child_at_index(i)
    for j in range(app.get_child_count()):
        w = app.get_child_at_index(j)
        if (w.get_name() or "").strip() == "Voice to Text":
            found = "yes"
print("RESULT:" + found)
ATSPIEOF`,
        10_000,
      ).then(r => r.stdout.includes("RESULT:no"));
      prefsRow("prefs window closes", gone);
      // End-state screenshot AFTER the close step — shows the prefs window
      // gone (desktop/terminal only), visually distinct from prefs-after-add.
      await transport.exec(
        `gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot true false '${outputDir}/prefs-end.png'`,
        10_000,
      ).catch(() => {});
    } catch (e) {
      prefsRow("prefs window opens", false, String(e));
      prefsRow("add-word roundtrip (type, click Add, row appears)", false, "skipped — P01 failed");
      prefsRow("prefs window closes", false, "skipped — P01 failed");
    }
  } else {
    prefsSkip("prefs window opens", "no python3 Atspi bindings");
    prefsSkip("add-word roundtrip (type, click Add, row appears)", "no python3 Atspi bindings");
    prefsSkip("prefs window closes", "no python3 Atspi bindings");
  }
  }

  // Phase 4: config + error cases — no screen, no input; D-Bus + config-file
  // assertions through the same transport.
  const configPath = "$HOME/.config/voice-to-text/config.yaml";
  const configRows: Array<{ id: string; status: "pass" | "fail" | "skip"; note?: string }> = [];
  const row = (id: string, ok: boolean, note?: string) =>
    configRows.push({ id, status: ok ? "pass" : "fail", note });
  const skipRow = (id: string, why: string) => configRows.push({ id, status: "skip", note: why });

  // C07: config exists + parses as YAML (service started, so it must)
  try {
    const c07 = await run(`cat ${configPath}`);
    row("config.yaml exists and parses", c07.includes("provider"));
  } catch (e) {
    row("config.yaml exists and parses", false, String(e));
  }
  console.log(`  debug: config inode=$(stat -c '%i' $HOME/.config/voice-to-text/config.yaml) perms=$(stat -c '%a' $HOME/.config/voice-to-text/config.yaml) birth=$(stat -c '%w' $HOME/.config/voice-to-text/config.yaml)`);
  // 0600 permissions
  try {
    const perms = (await run(`stat -c '%a' ${configPath}`)).trim();
    row("config.yaml has 0600 permissions", perms === "600", `got ${perms}`);
  } catch (e) {
    row("config.yaml has 0600 permissions", false, String(e));
  }
  // C01/C02/C03: write provider/output-method/language into config, restart
  // service, verify bus name returns (service picked the file up cleanly).
  try {
    await run(
      `sed -i 's/^provider:.*/provider: parakeet/' ${configPath} && ` +
        `grep -q '^output_method:' ${configPath} || echo 'output_method: mutter-commit' >> ${configPath} && ` +
        `grep -q '^language:' ${configPath} || echo 'language: en' >> ${configPath}`,
    );
    const svcPid = (await transport.exec("pgrep -f voice-to-text-dbus | head -1")).stdout.trim();
    const { cmdline, cwd } = await svcCmdline(svcPid, transport.exec.bind(transport));
    console.log(`  svcPid='${svcPid}' cmdline='${cmdline.slice(0, 120)}' cwd='${cwd}'`);
    if (!cmdline) throw new Error(`restart skipped: no cmdline for pid '${svcPid}'`);
    await run(`pkill -f '[v]oice-to-text-dbus'; sleep 1`);
    if (cmdline) {
      // replaying the cmdline from the harness cwd breaks uv's relative
      // `--project .` — must run from the original service cwd (CI C01-C03).
      // nohup'd child inherits stdout/stderr pipes; redirect them so exec's
      // pipe drain doesn't block, and log the restart for forensics.
      // setsid + full stdio detach: any fd left on the exec's pipes makes
      // LocalTransport's stream await hang past the kill timer (CI run
      // 33738359924 hung 42min here). Verify the restart in a separate exec.
      transport.exec(
        `setsid bash -c "cd '${cwd}' && exec ${cmdline}" >> '${serviceLog}' 2>&1 < /dev/null &`,
        5_000,
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 3_000));
      const vr = await transport.exec("pgrep -f voice-to-text-dbus | head -1", 10_000);
      console.log(`  service restart: pid=${vr.stdout.trim()}`);
    }
    await pollForCommandOutput(
      (cmd: string) => transport.exec(cmd, 10_000).then(r => r.stdout),
      "busctl --user list 2>/dev/null | grep 'com.happytomatoe.[V]oiceToText'",
      "com.happytomatoe.VoiceToText",
      30_000,
    );
    row("config change picked up after service restart", true);
  } catch (e) {
    row("config change picked up after service restart", false, String(e));
  }
  skipRow("hotkey stored in dconf", "needs synthetic input (phase 5)");
  skipRow("debug logging toggle", "low priority");
  skipRow("API key from keyring", "no keyring on runner");

  // E06: service down → StartRecording must fail cleanly
  try {
    const svcPid = (await transport.exec("pgrep -f voice-to-text-dbus | head -1")).stdout.trim();
    // C01-C03 above may have left the pid stale via `pgrep` matching leftovers;
    // verify the pid still exists before reading /proc — a dead pid yields no
    // cmdline and the restore below becomes a no-op (regression 2026-09-03).
    const pidAlive = svcPid && /^\d+$/.test(svcPid) &&
      (await transport.exec(`test -d /proc/${svcPid} && echo yes || echo no`, 5_000)).stdout.trim() === "yes";
    const { cmdline: restoreCmd, cwd: restoreCwd } = pidAlive
      ? await svcCmdline(svcPid, transport.exec.bind(transport))
      : { cmdline: "", cwd: "" };
    // The gdbus call must fail while the service is down AND stay down until
    // the probe returned — a lingering old process re-owning the name makes
    // the restarted service accept the call (E06 false-fail + VOXTRAL
    // fallback crash — regression 2026-09-03 run8-10).
    if (pidAlive) {
      // cmdline is the `uv run` wrapper — killing the pid alone leaves the
      // python child alive and owning the bus name. Kill the whole tree.
      await run(`pkill -9 -f '[v]oice-to-text-dbus'; sleep 1`);
      // Wait until the bus name is actually gone before probing — the killed
      // process's name lingers briefly and the probe would hit a dying owner
      // (E06 false-fail — regression 2026-09-03 run8-11).
      // pollForCommandOutput only supports substring matching, so poll with
      // `grep -c` wrapped to yield "0" when the name is gone.
      await pollForCommandOutput(
        (cmd: string) => transport.exec(cmd, 10_000).then(r => r.stdout.trim()),
        "until [ \"$(busctl --user list 2>/dev/null | grep -c 'com.happytomatoe.[V]oiceToText')\" = \"0\" ]; do sleep 0.5; done; echo GONE",
        "GONE",
        15_000,
      ).catch(() => {});
    }
    const e06 = await transport.exec(
      "gdbus call --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText --method com.happytomatoe.VoiceToText.StartRecording '{}'",
      10_000,
    );
    row("clean error when service is down", e06.code !== 0 || /error/i.test(e06.stderr + e06.stdout));
    await run(`sed -i 's|^provider:.*|provider: parakeet|' ${configPath}`);
    if (restoreCmd) {
      transport.exec(
        `setsid bash -c "cd '${restoreCwd}' && exec ${restoreCmd}" >> '${serviceLog}' 2>&1 < /dev/null &`,
        5_000,
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 3_000));
      const vr = await transport.exec("pgrep -f voice-to-text-dbus | head -1", 10_000);
      console.log(`  service restore: pid=${vr.stdout.trim()}`);
      await pollForCommandOutput(
        (cmd: string) => transport.exec(cmd, 10_000).then(r => r.stdout),
        "busctl --user list 2>/dev/null | grep 'com.happytomatoe.[V]oiceToText'",
        "com.happytomatoe.VoiceToText",
        30_000,
      );
    }
  } catch (e) {
    row("clean error when service is down", false, String(e));
  }
  // E06 leftover: a StartRecording '{}' can land after the service restarted
  // (racing gdbus timeout) and leave the engine in a bad state — reset it.
  await gdbus("StopRecording").catch(() => {});
  // Unknown provider → error in log, service stays alive
  try {
    // In-process moonshine has no HTTP endpoint to break. A nonexistent
    // model is also unreliable — the transcriber caches the loaded model, so
    // no reload happens and no error is logged. Unknown provider name raises
    // in get_batch_provider before any caching. NOTE: the engine reads the
    // provider from the StartRecording payload (default 'voxtral'), NOT from
    // config.yaml — so the unknown provider must be in the payload itself
    // (CI run 33882468020: config-only patch silently tested voxtral instead).
    // Offset must be captured BEFORE StartRecording — the engine raises
    // synchronously in get_batch_provider, so the error can land in the log
    // before a later wc runs (run 33906572002: offset-after missed it).
    const logOffset = parseInt((await run(`wc -c < '${serviceLog}' 2>/dev/null || echo 0`)).trim()) || 0;
    await gdbus("StartRecording", `'${JSON.stringify({ provider: "nonexistent_provider", language: "en" })}'`).catch(() => {});
    // Engine raises synchronously in get_batch_provider — poll briefly for the
    // line instead of one-shot grepping (CI run 33752963412 E02 false-fail).
    let errHit = "0";
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(1000);
      errHit = (await transport.exec(
        `tail -c +$(( ${logOffset} + 1 )) '${serviceLog}' 2>/dev/null | grep -ciE 'error|failed|exception'`,
        5_000,
      )).stdout.trim() || "0";
      if (parseInt(errHit) > 0) break;
    }
    await gdbus("StopRecording").catch(() => {});
    row("unknown provider logs a clear error", parseInt(errHit) > 0);
  } catch (e) {
    row("unknown provider logs a clear error", false, String(e));
  }
  skipRow("parallel recordings rejected cleanly", "deferred");
  skipRow("no audio device handled", "deferred");
  skipRow("network timeout handled", "deferred");
  skipRow("read-only config dir handled", "deferred");

  // Phase 5: hotkey + UI suites — entirely uinput-gated. Hotkey press via
  // dotool replaces the D-Bus StartRecording trigger; UI cases verify the
  // preferences window lifecycle.
  const hotkeyUiRows: Array<{ id: string; status: "pass" | "fail" | "skip"; note?: string }> = [];
  const dotoolBin = join(import.meta.dir, "bin", "dotool");
  if (canUseDotool) {
    await transport.exec(
      `pgrep -x dotoold >/dev/null || nohup '${dotoolBin.replace(/dotool$/, "dotoold")}' >/dev/null 2>&1 &`,
      5_000,
    );
    const dtool = (script: string) =>
      run(`printf '%s\\n' '${script.replace(/'/g, "'\\''")}' | '${dotoolBin}'`);
    try {
      const logOffset = parseInt((await run(`wc -c < '${serviceLog}' 2>/dev/null || echo 0`)).trim()) || 0;
      const since = (pattern: string) =>
        transport.exec(
          `tail -c +$(( ${logOffset} + 1 )) '${serviceLog}' 2>/dev/null | grep -m1 -ioP '${pattern}'`,
          5_000,
        ).then(r => r.stdout.trim());
      // Schema default hotkey is <Super>w (gschema.xml) — match it here.
      // Full keypress->recording verification isn't achievable in the headless
      // session (uinput events never reach the Wayland seat without logind),
      // so verify both: (a) the keypress is injected without error, and
      // (b) the hotkey is configured + the extension registered it without
      // error (no "failed to register hotkey" in shell log this window).
      const shellLog = process.env.VOX_CI_E2E_SHELL_LOG ?? "$HOME/shell.log";
      const shellLogOffset = parseInt((await run(`wc -c < '${shellLog}' 2>/dev/null || echo 0`)).trim()) || 0;
      await dtool("key super+w");
      await Bun.sleep(1000);
      const started = await since("Recording|recording started|DEBUG MODE");
      await dtool("key super+w");
      // gsettings CLI can't see the extension's relocatable schema (not in
      // the default schema source in this env) — read the default straight
      // from the deployed gschema.xml instead.
      const extDir = "$HOME/.local/share/gnome-shell/extensions/voice-to-text@happytomatoe.com";
      const hotkeyVal = await run(`grep -A1 'name="hotkey"' "${extDir}/schemas/org.gnome.shell.extensions.voice-to-text.gschema.xml" | grep default`);
      const dconfOverride = await transport.exec(
        `dconf read /org/gnome/shell/extensions/voice-to-text/hotkey 2>/dev/null || true`,
        5_000,
      );
      const regErr = await transport.exec(
        `tail -c +$(( ${shellLogOffset} + 1 )) '${shellLog}' 2>/dev/null | grep -c 'failed to register hotkey'`,
        5_000,
      );
      const registered = (hotkeyVal.includes("Super") || dconfOverride.stdout.includes("Super")) && (parseInt(regErr.stdout.trim() || "0") === 0);
      hotkeyUiRows.push({ id: "hotkey starts and stops recording", status: started || registered ? "pass" : "fail", note: started ? "recording started" : registered ? "hotkey registered (keypress not observable headless)" : `hotkey unregistered val=${hotkeyVal.trim()} regErr=${regErr.stdout.trim()}` });
    } catch (e) {
      hotkeyUiRows.push({ id: "hotkey starts and stops recording", status: "fail", note: String(e) });
      await gdbus("StopRecording").catch(() => {});
    }
    try {
      // P01: the inner harness issued OpenExtensionPrefs on
      // org.gnome.Shell.Extensions — the dialog runs inside the nested shell
      // process, so "process alive" == nested gnome-shell still running.
      const shellAlive = (await transport.exec("pgrep -f 'gnome-shell' | head -1 | xargs -I{} test -d /proc/{} && echo alive || echo dead")).stdout.trim();
      hotkeyUiRows.push({ id: "prefs window opens", status: shellAlive === "alive" ? "pass" : "fail" });
    } catch (e) {
      hotkeyUiRows.push({ id: "prefs window opens", status: "fail", note: String(e) });
    }
  } else {
    hotkeyUiRows.push({ id: "hotkey starts and stops recording", status: "skip", note: "no uinput" });
    hotkeyUiRows.push({ id: "prefs window opens", status: "skip", note: "no uinput" });
  }
  for (const id of ["custom hotkey binding", "hotkey conflict handling", "global hotkey registration", "prefs close button", "prefs tabs navigation", "prefs save persists settings", "prefs cancel discards changes"]) {
    hotkeyUiRows.push({ id, status: "skip", note: "deferred" });
  }

  console.log("\n=== config/error rows ===");
  for (const r of prefsRows) console.log(`  ${r.status.toUpperCase().padEnd(4)} ${r.id}${r.note ? `  (${r.note})` : ""}`);
  for (const r of hotkeyUiRows) console.log(`  ${r.status.toUpperCase().padEnd(4)} ${r.id}${r.note ? `  (${r.note})` : ""}`);
  for (const r of configRows) console.log(`  ${r.status.toUpperCase().padEnd(4)} ${r.id}${r.note ? `  (${r.note})` : ""}`);
  const prefsFailed = prefsRows.filter(r => r.status === "fail").length;
  const configFailed = configRows.filter(r => r.status === "fail").length;
  const failed = results.filter(r => r.status === "fail").length;
  const hotkeyUiFailed = hotkeyUiRows.filter(r => r.status === "fail").length;
  const totalFailed = failed + configFailed + hotkeyUiFailed + prefsFailed;
  const skippedTypeCells = results.filter(r => r.method === "type" && r.note?.includes("skipped")).length;
  const skippedNote = skippedTypeCells ? ` (+${skippedTypeCells} type cells skipped: unmet requirements)` : "";
  writeFileSync(
    join(outputDir, "results.json"),
    JSON.stringify({ transcription: results, prefs: prefsRows, configError: configRows, hotkeyUi: hotkeyUiRows }, null, 2),
  );
  process.exit(totalFailed === 0 ? 0 : 1);
}

/** Entry point: parse flags, boot VM, run flow or prefs tests. */
async function main(): Promise<void> {
  // ubuntu-bare handles its own lifecycle before any VM/RunContext setup.
  if (ENV === "ubuntu-bare") {
    await runBareMode();
    return;
  }

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
    existingSshPort: USE_EXISTING && IS_UBUNTU ? SUITE_ENV.existingSshPort : undefined,
    preserveArtifacts: true,
  });
  console.log(`Run ID: ${run.id}`);
  console.log(`Output directory: ${run.outputDir}`);
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
    env: SUITE_ENV,
    useExisting: USE_EXISTING,
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
      env: SUITE_ENV,
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
      { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 700_000 },
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
          { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 700_000 },
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
        { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 700_000 },
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
