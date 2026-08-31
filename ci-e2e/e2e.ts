/**
 * CI headless E2E test runner.
 *
 * Runs INSIDE the dbus-run-session (spawned by ci-e2e-headless-inner.sh) with:
 *   - DBUS_SESSION_BUS_ADDRESS pointing at the private session bus
 *   - VOX_CI_E2E_TEXT_FILE: path where the extension captures typed text
 *
 * Drives one hardcoded test case end to end:
 *   StartRecording (debug WAV mode, parakeet provider, mutter-commit output)
 *   → assert StateChanged transitions, no Error signal
 *   → assert typed text (via capture file) matches expected transcription
 *
 * Exit code 0 = pass; nonzero = fail. Logs everything for artifact triage.
 */

const BUS = "com.happytomatoe.VoiceToText";
const PATH = "/com/happytomatoe/VoiceToText";
const IFACE = "com.happytomatoe.VoiceToText";
const TIMEOUT_MS = 90_000;

const fixture = JSON.parse(await Bun.file(new URL("./fixture.json", import.meta.url)).text());

const textFile = process.env.VOX_CI_E2E_TEXT_FILE;
if (!textFile) {
  console.error("FATAL: VOX_CI_E2E_TEXT_FILE not set (must run inside harness)");
  process.exit(1);
}

// ── gdbus helpers ────────────────────────────────────────────────────────────

async function gdbus(args: string[], timeoutMs = 10_000): Promise<string> {
  const proc = Bun.spawn(["gdbus", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`gdbus ${args.join(" ")} failed (${code}): ${stderr}`);
  return stdout;
}

async function waitForBusName(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const names = await gdbus([
        "call", "--session",
        "--dest", "org.freedesktop.DBus",
        "--object-path", "/org/freedesktop/DBus",
        "--method", "org.freedesktop.DBus.ListNames",
      ]);
      if (names.includes(BUS)) return;
    } catch { /* bus may still be starting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Bus name ${BUS} not owned after ${timeoutMs}ms`);
}

/**
 * Monitor D-Bus signals from the service. Resolves when StopRecording is
 * called; the caller then inspects the collected transitions.
 */
async function monitorSignals(): Promise<{ lines: string[]; stop: () => Promise<void> }> {
  const proc = Bun.spawn(
    ["gdbus", "monitor", "--session", "--dest", BUS, "--object-path", PATH],
    { stdout: "pipe", stderr: "pipe" },
  );
  const lines: string[] = [];
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          lines.push(line);
          console.log(`  [signal] ${line.trim()}`);
        }
      }
    }
  })();
  return {
    lines,
    stop: async () => { proc.kill(); await proc.exited; },
  };
}

// ── assertions ────────────────────────────────────────────────────────────────

const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  PASS: ${msg}`); } else { failures.push(msg); console.error(`  FAIL: ${msg}`); }
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
}

// ── test ──────────────────────────────────────────────────────────────────────

console.log("CI E2E: waiting for service on bus...");
await waitForBusName(30_000);
console.log(`CI E2E: ${BUS} owned. Starting monitor.`);

const { lines: signalLines, stop } = await monitorSignals();
await new Promise((r) => setTimeout(r, 1000)); // let monitor attach

// Debug mode: the harness sets VOICE_TO_TEXT_DEBUG_FILE so the engine
// transcribes our WAV instead of reading a microphone.
const config = JSON.stringify({
  provider: "parakeet",
  output_method: "mutter-commit",
  language: "en",
});
console.log(`CI E2E: StartRecording(${config})`);
await gdbus([
  "call", "--session",
  "--dest", BUS, "--object-path", PATH,
  "--method", `${IFACE}.StartRecording`,
  config,
]);
console.log("CI E2E: recording started; waiting for completion...");

// Poll for the typed-text capture file (written by the extension when
// CommitText lands in the headless fallback path).
const deadline = Date.now() + TIMEOUT_MS;
let typedText: string | null = null;
let sawError: string | null = null;
while (Date.now() < deadline) {
  const blob = Bun.file(textFile);
  if (await blob.exists()) {
    typedText = await blob.text();
    break;
  }
  const errLine = signalLines.find((l) => l.includes("Error"));
  if (errLine) { sawError = errLine; break; }
  await new Promise((r) => setTimeout(r, 1000));
}
await stop();

// ── report ────────────────────────────────────────────────────────────────────
console.log("\n=== CI E2E RESULTS ===");
assert(typedText !== null, "typed text was captured (CommitText reached extension)");
if (typedText !== null) {
  assert(
    normalize(typedText) === normalize(fixture.expected),
    `typed text matches expected: got '${normalize(typedText)}', want '${normalize(fixture.expected)}'`,
  );
}
assert(sawError === null, "no Error signal emitted");
const stateTransitions = signalLines.filter((l) => l.includes("StateChanged"));
assert(stateTransitions.length > 0, `StateChanged signals observed (${stateTransitions.length})`);

console.log(`\nsignal lines: ${signalLines.length}`);
console.log(`typed text:   ${typedText === null ? "(none)" : JSON.stringify(typedText)}`);

if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nPASSED");
