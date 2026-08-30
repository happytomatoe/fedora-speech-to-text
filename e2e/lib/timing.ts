import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Span-based timing accounting. Guarantees that wall time = Σ(root spans) +
 * unaccounted, by construction: unaccounted is computed by subtraction at
 * print time, so a forgotten section can never be silently missing — it shows
 * up as a bigger unaccounted bucket.
 */

interface Span {
  label: string;
  start: number;
  dur?: number;
  children: Span[];
  failed?: boolean;
}

const stack: Span[] = [];
let root: Span[] = [];
let rootStart = 0;

/** Live flat output, mirroring the old `[time]` lines (set to false to silence). */
const LIVE_LINES = true;

/** Directory for the raw timing dump (overridable via E2E_TIMING_DIR). */
function outputDir(): string {
  // Late import avoidance: accept any env-provided dir, default to cwd/output.
  return process.env.E2E_TIMING_DIR ?? "output";
}

/** Path of the append-only JSONL dump of finished runs. */
function dumpPath(): string {
  return join(outputDir(), ".timing-tree.json");
}

let started = false;

/** Begin a named span; nested spans become children of the enclosing one. */
export function beginSpan(label: string): void {
  if (!started) {
    started = true;
    rootStart = Date.now();
  }
  stack.push({ label, start: Date.now(), children: [] });
}

/** Close the innermost open span (optionally marking it failed). */
export function endSpan(failed = false): void {
  const s = stack.pop();
  if (!s) throw new Error("endSpan() without beginSpan()");
  s.dur = Date.now() - s.start;
  s.failed = failed;
  const parent = stack.at(-1);
  if (parent) parent.children.push(s);
  else {
    root.push(s);
    if (LIVE_LINES) console.log(`  [time] ${s.label}: ${s.dur}ms${failed ? " (FAILED)" : ""}`);
  }
}

/** Print the nested tree + unaccounted bucket. Also dumps raw spans as JSON. */
export function printTimingTree(): void {
  if (stack.length > 0) {
    console.log(`  [timing] WARNING: ${stack.length} span(s) never ended: ${stack.map((s) => s.label).join(", ")}`);
    while (stack.length > 0) endSpan(true);
  }
  const wall = Date.now() - rootStart;
  if (root.length === 0) return;

  const accounted = root.reduce((sum, s) => sum + (s.dur ?? 0), 0);
  const unaccounted = wall - accounted;

  console.log("\n=== Timing Tree ===");
  const walk = (nodes: Span[], depth: number): void => {
    for (const n of nodes) {
      const pad = "  ".repeat(depth) + (depth > 0 ? "└─ " : "");
      console.log(`${pad}${n.label}: ${fmt(n.dur ?? 0)}${n.failed ? "  ← FAILED" : ""}`);
      walk(n.children, depth + 1);
    }
  };
  walk(root, 0);
  console.log(`wall: ${fmt(wall)} | unaccounted: ${fmt(unaccounted)}`);
  if (unaccounted > 3000) {
    console.log(`  [timing] unaccounted > 3s — add spans around unmeasured sections`);
  }

  try {
    if (!existsSync(outputDir())) mkdirSync(outputDir(), { recursive: true });
    appendFileSync(dumpPath(), JSON.stringify({ wall, root, unaccounted, ts: new Date().toISOString() }) + "\n");
  } catch {
    // ignore: timing dump is best-effort
  }
}

/** Format milliseconds for display: seconds above 10s, raw ms below. */
function fmt(ms: number): string {
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
