import { ensureParakeet } from "./lib/parakeet.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { join } from "node:path";
import { StepRunner } from "./lib/step-runner.js";
import { VmManager, type VmConfig } from "./lib/vm.js";
import { RunContext } from "./lib/run-context.js";
import { deployTestAudio, deployExtension, startVoiceService } from "./lib/deploy-steps.js";
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

console.log = (...args: any[]) => {
  const msg = args.join(" ");
  appendFileSync(LOG_FILE, msg + "\n");
  origLog(...args);
};
console.error = (...args: any[]) => {
  const msg = args.join(" ");
  appendFileSync(LOG_FILE, "ERROR: " + msg + "\n");
  origError(...args);
};

// Parse CLI args
const args = process.argv.slice(2);
const UPDATE_MODE = args.includes("--update");
// Objective contract: a FAILED run leaves the VM alive for triage. --keep-vm
// forces it even after a PASS. Screenshots/recording land in run output (and
// are copied to output/<run-id>/ by cleanup); serial console + e2e.log are
// always preserved.
const KEEP_VM = args.includes("--keep-vm") || process.exitCode !== 0;
const SKIP_DEPS = args.includes("--skip-deps");
// --use-existing: attach to an already-running VM (e.g. e2e-vm/boot-vm.sh)
// instead of booting a fresh one — for reproducing CI failures locally
// against the same VM/image.
const USE_EXISTING = args.includes("--use-existing");

// Parse --timeout <seconds> (default: 600)
const timeoutIdx = args.indexOf("--timeout");
const GLOBAL_TIMEOUT_MS = timeoutIdx >= 0 ? (parseInt(args[timeoutIdx + 1]) || 600) * 1000 : 600_000;

// Parse --case <name> (select specific test case instead of random)
const caseIdx = args.indexOf("--case");
const SELECTED_CASE = caseIdx >= 0 ? args[caseIdx + 1] : undefined;

// Parse --output-method <method> (test specific output method: type, clipboard, mutter-virtual)
const outputMethodIdx = args.indexOf("--output-method");
const OUTPUT_METHOD = outputMethodIdx >= 0 ? args[outputMethodIdx + 1] : "type";

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

// Configuration — Ubuntu 26.04 (resolute) PINNED. The exact same cloud image
// URL must be used by local fresh-mode runs and CI, so a CI failure can be
// reproduced locally with identical bits.
const UBUNTU_2604_CLOUD_IMAGE = "https://cloud-images.ubuntu.com/daily/server/resolute/current/resolute-server-cloudimg-amd64.img";

const CONFIG = {
  paths: {
    projectRoot: join(import.meta.dir, ".."),
    suiteDir: import.meta.dir,
    vmDir: join(import.meta.dir, "vm-run"),
    baseImage: join(import.meta.dir, "golden-ubuntu-2604.qcow2"),
    sshKey: join(import.meta.dir, "id_ed25519"),
    referencesDir: join(import.meta.dir, "expected"),
    outputDir: join(import.meta.dir, "output"),
    pythonSrc: join(import.meta.dir, "../src/voice_to_text"),
    testCasesFile: join(import.meta.dir, "fixtures/test-cases.json"),
  },
  ssh: {
    // e2e-vm/boot-vm.sh parity VM: localhost:2222, key in e2e-vm/
    existing: {
      port: 2222,
      user: "testuser",
      key: join(import.meta.dir, "../e2e-vm/id_ed25519"),
    },
  },
  extension: {
    uuid: "voice-to-text@happytomatoe.com",
  },
};

// Derived constants
const PROJECT_ROOT = CONFIG.paths.projectRoot;
const SUITE_DIR = CONFIG.paths.suiteDir;
const VM_DIR = CONFIG.paths.vmDir;
const BASE_IMAGE = CONFIG.paths.baseImage;
const SSH_KEY = USE_EXISTING ? CONFIG.ssh.existing.key : CONFIG.paths.sshKey;
const SSH_PORT = USE_EXISTING ? CONFIG.ssh.existing.port : 2222;
const SSH_USER = CONFIG.ssh.existing.user;
const OUTPUT_DIR = CONFIG.paths.outputDir;
const PYTHON_SRC = CONFIG.paths.pythonSrc;
const TEST_CASES_FILE = CONFIG.paths.testCasesFile;

interface TestCaseFile {
  file: string;
  expected: string;
}

/** Pick which fixture audio case this run transcribes. */
function pickTestCase(): TestCaseFile {
  const data = JSON.parse(readFileSync(TEST_CASES_FILE, "utf-8"));
  const cases: TestCaseFile[] = data["test-cases"];
  if (SELECTED_CASE) {
    const picked = cases.find(c => c.file.includes(SELECTED_CASE));
    if (!picked) {
      throw new Error(`Test case '${SELECTED_CASE}' not found. Available: ${cases.map(c => c.file).join(", ")}`);
    }
    console.log(`  Selected test case (by name): ${picked.file}`);
    return picked;
  }
  const picked = cases[Math.floor(Math.random() * cases.length)];
  console.log(`  Selected test case (random): ${picked.file}`);
  return picked;
}

const CURRENT_TEST = pickTestCase();
const EXPECTED_TEXT = CURRENT_TEST.expected;

/** Fail fast when prerequisites are missing. */
async function preflight(): Promise<void> {
  if (!USE_EXISTING) {
    if (!existsSync(BASE_IMAGE)) {
      throw new Error(`Base VM image not found: ${BASE_IMAGE}\nRun 'just ubuntu-ci-e2e-setup' first (downloads ${UBUNTU_2604_CLOUD_IMAGE}).`);
    }
    if (!existsSync(CONFIG.paths.sshKey)) {
      throw new Error(`SSH key not found: ${CONFIG.paths.sshKey}\nRun 'just ubuntu-ci-e2e-setup' first.`);
    }
  } else if (!existsSync(SSH_KEY)) {
    throw new Error(`SSH key not found: ${SSH_KEY}\nRun 'just ubuntu-vm-setup' first (e2e-vm/).`);
  }

  // Ensure Parakeet is available for local transcription
  await ensureParakeet();
}

/** Print an elapsed-time line for a labeled phase. */
function timing(label: string, startMs: number): void {
  const ms = Date.now() - startMs;
  console.log(`  [time] ${label}: ${ms}ms`);
}

/** Get test case name from file path (e.g., "test-03-hello.wav" → "test-03-hello") */
function getTestCaseName(): string {
  return CURRENT_TEST.file.replace(/\.wav$/, "");
}

/** Full single-VM test flow: terminal, recording, transcription. */
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

  // Step 1: Dismiss Activities overview (D-Bus Set is idempotent)
  beginSpan("dismiss-activities");
  console.log("Dismissing Activities...");
  await shell.dismissActivities();
  await shell.waitActivitiesDismissed();
  endSpan();

  // Step 2: Open terminal with tmux inside (dotool needs a focused window)
  beginSpan("open-terminal");
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
  endSpan();

  // Step 3: Snapshot pane content before recording (for transcription detection)
  beginSpan("snapshot-pane");
  const preRecordingPane = await tmux.capturePane(tmuxCfg);
  console.log("Pre-recording pane captured.");
  endSpan();

  // Start in-VM screen recording (GNOME Shell Screencast via the persistent
  // Python holder — keeps the D-Bus connection open so gnome-shell doesn't
  // abort with "Sender has vanished"; SIGTERM stops it gracefully).
  beginSpan("start-screencast");
  const screencastDir = join(run.outputDir, "test-cases", getTestCaseName());
  mkdirSync(screencastDir, { recursive: true });
  let screencastFile = "";
  let screencastPid: number | null = null;
  try {
    await shell.exec("rm -f /tmp/e2e-screencast*.webm");
    // Upload the holder script and launch it detached; read the start line
    // from its log to learn the recording path.
    const holderLocal = join(import.meta.dir, "lib", "screencast-holder.py");
    execSync(
      `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${SSH_KEY} -P ${run.sshPort} ${holderLocal} ${SSH_USER}@localhost:/tmp/screencast-holder.py`,
      { encoding: "utf-8", timeout: 15000, stdio: "pipe" }
    );
    await shell.exec(
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus; " +
      "nohup python3 /tmp/screencast-holder.py /tmp/e2e-screencast > /tmp/screencast-holder.log 2>&1 < /dev/null & echo $!"
    );
    // Poll for the start line in the holder log
    await vm.pollUntil(
      "screencast start",
      async () => {
        try {
          const out = await shell.exec("cat /tmp/screencast-holder.log 2>/dev/null || true");
          if (out.includes("screencast-start failed")) throw new Error(`screencast start failed: ${out}`);
          if (out.includes("ok")) {
            screencastFile = out.match(/ok (\S+)/)?.[1] ?? "";
            return screencastFile.length > 0;
          }
          return false;
        } catch (e) {
          throw e;
        }
      },
      15000
    );
    screencastPid = parseInt((await shell.exec("pgrep -f screencast-holder.py | head -1")).trim(), 10) || null;
    console.log(`  Screencast started: ${screencastFile} (holder pid ${screencastPid})`);
  } catch (e) {
    console.log(`  Screencast not available (continuing without recording): ${e}`);
  }
  endSpan();

  // Ensure Activities is dismissed and terminal focused before the hotkey
  await shell.dismissActivities();
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

  // Step 4: Start recording via D-Bus (the extension's StartRecording; the
  // service transcribes the debug WAV instead of reading a microphone)
  beginSpan("start-recording");
  console.log("Starting recording via hotkey...");
  await shell.sendHotkey();
  await shell.waitForRecordingStart();
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

  // Step 6: Stop recording
  beginSpan("stop-recording");
  console.log("Stopping recording via hotkey...");
  await shell.sendHotkey();
  await Bun.sleep(200); // Brief settle for D-Bus round-trip
  endSpan();

  // Stop the screen recording (SIGTERM the holder — its signal handler calls
  // StopScreencast on the still-open bus connection, then exits).
  beginSpan("stop-screencast");
  if (screencastPid) {
    try {
      await shell.exec(`kill ${screencastPid} 2>/dev/null; true`);
      // Poll for the holder's stop confirmation
      await vm.pollUntil(
        "screencast stop",
        async () => {
          try {
            const out = await shell.exec("cat /tmp/screencast-holder.log 2>/dev/null || true");
            return out.includes("screencast-stop ok");
          } catch {
            return false;
          }
        },
        10000
      );
      console.log(`  Screencast stopped: ${screencastFile}`);
    } catch (e) {
      console.log(`  Screencast stop failed: ${e}`);
    }
  }
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

  // Cleanup: kill tmux session and terminal
  await tmux.killSession(tmuxCfg);
  await shell.exec("pkill -f ghostty 2>/dev/null; pkill -f gnome-terminal 2>/dev/null; true");
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

  // Retrieve screencast recording from the VM
  if (screencastFile) {
    // Validate path: must be an absolute /tmp path, no traversal, ends with .webm
    if (!/^\/tmp\/e2e-screencast[^']*\.webm$/.test(screencastFile)) {
      console.log(`  Screencast file path rejected: ${screencastFile}`);
    } else {
      t = Date.now();
      const localPath = join(screencastDir, "test-recording.webm");
      try {
        execSync(
          `scp -o StrictHostKeyChecking=no -i ${SSH_KEY} -P ${run.sshPort} ${SSH_USER}@localhost:${screencastFile} ${localPath}`,
          { encoding: "utf-8", timeout: 30000 }
        );
        const stats = execSync(`stat -c%s ${localPath}`, { encoding: "utf-8" }).trim();
        console.log(`  Screencast saved: ${localPath} (${(parseInt(stats) / 1024).toFixed(1)}KB)`);
      } catch (e) {
        console.log(`  Screencast retrieval failed: ${e}`);
      }
      timing("retrieve-screencast", t);
    }
  }
}

/**
 * Get screenshot path based on label and test case.
 * - Common screenshots (01-04, 06): output/common/
 * - Transcription screenshot (05): output/test-cases/{testCase}/
 */
function getScreenshotPath(label: string, testCase?: string, outputDir = OUTPUT_DIR): string {
  if (label === "05-transcription-received" && testCase) {
    return join(outputDir, "test-cases", testCase, `screenshot-${label}.png`);
  }
  return join(outputDir, "common", `screenshot-${label}.png`);
}

/**
 * Capture screenshot via QEMU monitor screendump and save as PNG.
 * On --use-existing (VM not started by us, monitor socket belongs to
 * e2e-vm/boot-vm.sh) falls back to the GNOME Shell Screenshot D-Bus API.
 */
async function captureScreenshot(label: string, run: RunContext, vm?: VmManager): Promise<string> {
  const testCase = getTestCaseName();
  const pngPath = getScreenshotPath(label, testCase, run.outputDir);
  const ppmPath = pngPath.replace(/\.png$/, ".ppm");

  // Ensure directory exists
  mkdirSync(join(pngPath, ".."), { recursive: true });

  try {
    if (vm && !USE_EXISTING) {
      // QemuMonitor (HMP over the monitor socket)
      await vm.qemu.screendump(ppmPath);
    } else {
      // In-VM screenshot via GNOME Shell Screenshot D-Bus, then pull it
      const remotePng = `/tmp/e2e-shot-${label}.png`;
      await vm!.shell.dbusScreenshot(remotePng);
      execSync(
        `scp -o StrictHostKeyChecking=no -i ${SSH_KEY} -P ${run.sshPort} ${SSH_USER}@localhost:${remotePng} ${pngPath}`,
        { encoding: "utf-8", timeout: 15000, stdio: "pipe" }
      );
      if (existsSync(pngPath)) {
        console.log(`  Screenshot saved: ${pngPath}`);
        return pngPath;
      }
      console.log(`  Screenshot capture failed: no PNG at ${pngPath}`);
      return "";
    }
    // Wait for file to be written
    await Bun.sleep(500);
    // Convert PPM to PNG
    execSync(`convert ${ppmPath} ${pngPath} 2>/dev/null || magick ${ppmPath} ${pngPath} 2>/dev/null || true`, {
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
  const referencePath = join(CONFIG.paths.referencesDir, "test-cases", testCase, "screenshot-05-transcription-received.png");
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
    // Screenshot missing is not fatal for the text assertion — log it
    console.log("  NOTE: screenshot capture failed — skipping visual regression");
  } else if (existsSync(referencePath)) {
    try {
      assertScreenshotMatches(referencePath, screenshot, run, "Visual regression");
    } catch (err) {
      return { passed: false, message: (err as Error).message, screenshot };
    }
  } else {
    console.log(`  No reference image (run with --update to create): ${referencePath}`);
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

  const testCaseRefDir = join(CONFIG.paths.referencesDir, "test-cases", testCase);
  mkdirSync(testCaseRefDir, { recursive: true });

  const transcriptionSrc = getScreenshotPath("05-transcription-received", testCase, run.outputDir);
  const transcriptionDst = join(testCaseRefDir, "screenshot-05-transcription-received.png");
  if (existsSync(transcriptionSrc)) {
    execSync(`cp "${transcriptionSrc}" "${transcriptionDst}"`, { encoding: "utf-8" });
    console.log(`  Copied: transcription → test-cases/${testCase}/`);
  }
}

/**
 * Compare a captured screenshot against its reference using pixelmatch.
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
  mkdirSync(join(diffPath, ".."), { recursive: true });
  writeFileSync(diffPath, PNG.sync.write(diff));
  if (ratio >= 0.01) {
    throw new Error(`${label}: diff-pixel ratio=${(ratio * 100).toFixed(3)}% (${diffPixels} px, threshold=1%), diff: ${diffPath}`);
  }
  console.log(`  ${label}: diff=${(ratio * 100).toFixed(3)}% (${diffPixels} px, pass)`);
}

/** Entry point: parse flags, boot VM, run flow. */
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
    updateMode: UPDATE_MODE,
    existingSshPort: USE_EXISTING ? SSH_PORT : undefined,
  });
  console.log(`Run ID: ${run.id}`);
  console.log(`Run directory: ${run.runDir}`);
  console.log(`SSH port: ${run.sshPort}`);
  if (USE_EXISTING) {
    console.log(`Mode: --use-existing (attaching to running VM on port ${run.sshPort})`);
  }

  const vmCfg: VmConfig = {
    run,
    baseImage: BASE_IMAGE,
    vmDir: VM_DIR,
    sshKey: SSH_KEY,
    sshUser: SSH_USER,
    projectRoot: PROJECT_ROOT,
    pythonSrc: PYTHON_SRC,
    fixtureDir: join(import.meta.dir, "fixtures"),
    suiteDir: SUITE_DIR,
    extensionUuid: CONFIG.extension.uuid,
    updateMode: UPDATE_MODE,
    testAudioFile: join(import.meta.dir, "fixtures", CURRENT_TEST.file),
    outputMethod: OUTPUT_METHOD,
    skipDeps: SKIP_DEPS,
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

  try {
    const steps: Array<{ name: string; fn: () => Promise<void>; timeout?: number }> = [
      { name: "preflight", fn: preflight },
    ];
    if (!USE_EXISTING) {
      steps.push(
        { name: "boot-vm", fn: () => vm.boot(), timeout: 120_000 },
      );
    }
    steps.push(
      { name: "wait-ssh", fn: () => vm.waitForSsh(), timeout: 120_000 },
      { name: "setup", fn: () => vm.setup(), timeout: 600_000 },
      { name: "test-flow", fn: () => runTestFlow(vm, run) },
    );
    await new StepRunner().run(steps);

    const result = await verifyWithScreenshot(vm, EXPECTED_TEXT, run);
    if (result.passed) {
      console.log(`  PASS: ${result.message}`);
    } else {
      console.log(`  FAIL: ${result.message}`);
      testsFailed++;
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
    if (!KEEP_VM && !USE_EXISTING) {
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
    } else if (USE_EXISTING) {
      console.log("\nExisting VM left running (--use-existing).");
      vm.shutdown().catch(() => {});
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
    process.exit(1);
  }
}

main();
