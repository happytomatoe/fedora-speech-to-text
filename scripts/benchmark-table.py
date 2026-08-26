#!/usr/bin/env python3
"""Parse benchmark run output and emit a markdown table.

Reads text like:
    ydotool (type) run 2: 4756.59 ms (49 chars/sec)
    dotool (type) run 1: 2036.00 ms (115 chars/sec)
    mutter-commit (CommitText) run 1: 3.87 ms (60767 chars/sec)

Usage:
    python3 scripts/benchmark-table.py < bench-output.txt
    python3 scripts/benchmark-table.py bench-output.txt
"""

import re
import statistics
import sys


LINE_RE = re.compile(
    r"^\s*(?P<method>.+?)\s+run\s+\d+:\s+(?P<ms>\d+(?:\.\d+)?)\s*ms"
    r"(?:\s+\((?P<cps>\d+)\s*chars/sec\))?"
)


def parse(text):
    runs = {}  # method -> list of ms (cps optional)
    for line in text.splitlines():
        m = LINE_RE.search(line)
        if m:
            runs.setdefault(m.group("method").strip(), []).append(float(m.group("ms")))
    return runs


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as f:
            text = f.read()
    else:
        text = sys.stdin.read()

    runs = parse(text)
    if not runs:
        print("No benchmark lines found.", file=sys.stderr)
        sys.exit(1)

    stats = {}
    for method, vals in runs.items():
        avg_ms = statistics.mean(vals)
        stats[method] = avg_ms

    baseline = min(stats, key=lambda m: stats[m])  # fastest = baseline
    base_ms = stats[baseline]

    header = "| Output method | Average time | vs baseline (× slower) |"
    sep = "| -------------- | ------------ | ---------------------- |"

    # Order: baseline first, then slowest -> fastest (or keep insertion order)
    ordered = sorted(stats, key=lambda m: stats[m])

    print()
    print(f"Baseline: **{baseline}** ({base_ms:.2f} ms)")
    print()
    print(header)
    print(sep)
    for method in ordered:
        avg_ms = stats[method]
        if method == baseline:
            slower = "baseline"
        else:
            slower = f"{avg_ms / base_ms:.0f}× slower"
        print(
            f"| {method} | {avg_ms:.2f} ms | {slower} |"
        )


if __name__ == "__main__":
    main()
