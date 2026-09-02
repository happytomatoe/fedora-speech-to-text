#!/usr/bin/env python3
"""DIY CRAP score: radon cyclomatic complexity + coverage.xml -> per-function CRAP.

CRAP = CC^2 * (1 - coverage)^3 + CC
"""

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

REPORTS = Path("metrics-report")


def load_coverage() -> dict[str, set[int]]:
    root = ET.parse(REPORTS / "coverage.xml").getroot()
    covered: dict[str, set[int]] = {}
    for cls in root.iter("class"):
        filename = cls.get("filename", "")
        lines = covered.setdefault(filename, set())
        for line in cls.iter("line"):
            if line.get("hits") != "0":
                lines.add(int(line.get("number")))
    return covered


def load_complexity() -> list[dict]:
    data = json.loads((REPORTS / "radon-cc.json").read_text())
    out = []
    for filepath, blocks in data.items():
        for block in blocks:
            if block["type"] not in ("function", "method"):
                continue
            out.append({
                "file": filepath,
                "name": block["name"],
                "line": block["lineno"],
                "endline": block["endline"],
                "cc": block["complexity"],
            })
    return out


def main() -> int:
    coverage = load_coverage()
    functions = load_complexity()
    rows = []
    for fn in functions:
        rel = fn["file"].removeprefix("src/voice_to_text/")
        src_file = f"src/voice_to_text/{rel}"
        lines = coverage.get(src_file, set()) | coverage.get(fn["file"], set())
        span = range(fn["line"], fn["endline"] + 1)
        covered = sum(1 for n in span if n in lines)
        cov = covered / len(span) if span else 0.0
        cc = fn["cc"]
        crap = round(cc * cc * (1 - cov) ** 3 + cc, 1)
        rows.append({**fn, "coverage": round(cov, 2), "crap": crap})

    rows.sort(key=lambda r: r["crap"], reverse=True)
    (REPORTS / "crap.json").write_text(json.dumps(rows, indent=2))
    over = [r for r in rows if r["crap"] > 30]
    print(f"CRAP > 30: {len(over)} of {len(rows)} functions")
    for r in over[:15]:
        print(f"  {r['crap']:>7.1f}  cc={r['cc']:<3} cov={r['coverage']:<5} {r['file']}:{r['line']} {r['name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
