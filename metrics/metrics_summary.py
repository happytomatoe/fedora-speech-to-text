"""Render a formatted summary table from the reports in metrics-report/."""

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

REPORTS = Path("metrics-report")


def load_json(name):
    return json.loads((REPORTS / name).read_text())


def fmt_row(cells, widths):
    return "| " + " | ".join(str(c).ljust(w) for c, w in zip(cells, widths, strict=False)) + " |"


def table(headers, rows):
    widths = [len(h) for h in headers]
    for row in rows:
        for i, c in enumerate(row):
            widths[i] = max(widths[i], len(str(c)))
    sep = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    out = [sep, fmt_row(headers, widths), sep]
    out += [fmt_row(r, widths) for r in rows]
    out.append(sep)
    return "\n".join(out)


def report_lines(name):
    return (REPORTS / name).read_text().splitlines()


def short_msg(msg):
    # sonarjs cyclomatic rule packs a JSON blob into the message; extract the number
    if '"' in msg:
        m = re.search(r"complexity of (\d+) which is greater than (\d+)", msg)
        return f"cyclomatic {m.group(1)} > {m.group(2)}" if m else msg
    return msg.replace("Refactor this function to reduce its ", "").replace(" allowed.", "")


def main():
    lines = ["# Metrics Summary", ""]

    # Python: SLOC, cyclomatic, cognitive, coverage, CRAP
    raw = load_json("radon-raw.json")
    py_sloc = sum(f.get("sloc", 0) for f in raw.values())

    cc = load_json("radon-cc.json")

    def short(path):
        return path.replace("src/voice_to_text/", "")

    funcs = []
    for path, blocks in cc.items():
        for b in blocks:
            if b["type"] in ("function", "method"):
                b["file"] = short(path)
                funcs.append(b)
    ccs = [b["complexity"] for b in funcs]

    cog = load_json("complexipy-results.json")
    cog_scores = [f["complexity"] for f in cog]

    cov = ET.parse(REPORTS / "coverage.xml").getroot()
    line_rate = float(cov.attrib["line-rate"])

    crap = load_json("crap.json")

    # JS: SLOC, complexity issues
    js_total = next(
        (int(x.split()[0]) for x in report_lines("js-loc.txt") if "total" in x),
        0,
    )
    eslint = load_json("eslint-complexity.json")
    js_issues = [
        m
        for f in eslint
        for m in f["messages"]
        if m.get("ruleId") and m["ruleId"].startswith("sonarjs/")
    ]

    # Cross-cutting
    jscpd = load_json("jscpd/jscpd-report.json")["statistics"]["total"]
    pyright = load_json("any-unknown-count.json")["pyright_summary"]

    overview = table(
        ["Metric", "Python", "JavaScript"],
        [
            ["SLOC", py_sloc, js_total],
            ["Avg cyclomatic", round(sum(ccs) / len(ccs), 1) if ccs else "-", "-"],
            ["Max cyclomatic", max(ccs) if ccs else "-", "-"],
            ["Cyclomatic > 10", sum(1 for c in ccs if c > 10), "-"],
            ["Avg cognitive", round(sum(cog_scores) / len(cog_scores), 1) if cog_scores else "-", "-"],
            ["Cognitive > 10", sum(1 for c in cog_scores if c > 10), "-"],
            ["Complexity issues > 22 (sonarjs)", "-", len(js_issues)],
            ["Coverage", f"{line_rate * 100:.1f}% (target 80%, not enforced)", "-"],
            ["CRAP > 30", sum(1 for c in crap if c["crap"] > 30), "-"],
            ["Duplicated lines", f"{jscpd['duplicatedLines']} ({jscpd['percentage']:.2f}%)", ""],
            ["Pyright errors", pyright["errorCount"], "-"],
            ["Dead code (vulture/knip)", f"{len(report_lines('vulture.txt'))} / {len(report_lines('knip.txt'))}", "-"],
        ],
    )
    lines += [overview, ""]

    top_cc = sorted(funcs, key=lambda b: -b["complexity"])[:5]
    rows = [[b["name"], b["file"], b["complexity"]] for b in top_cc]
    lines += ["## Top cyclomatic complexity (Python)", table(["Function", "File", "CC"], rows), ""]

    top_cog = sorted(cog, key=lambda f: -f["complexity"])[:5]
    rows = [[f["function_name"], f["path"].replace("src/voice_to_text/", ""), f["complexity"]] for f in top_cog]
    lines += ["## Top cognitive complexity (Python)", table(["Function", "File", "Score"], rows), ""]

    rows = [
        [c["name"], c["file"].replace("src/voice_to_text/", ""), c["cc"], f"{c['coverage'] * 100:.0f}%", c["crap"]]
        for c in sorted(crap, key=lambda c: -c["crap"])[:5]
    ]
    lines += ["## Top CRAP score (Python)", table(["Function", "File", "CC", "Cov", "CRAP"], rows), ""]

    rows = [
        [
            f["filePath"].split("/")[-1],
            m["ruleId"].split("/")[-1],
            m["line"],
            short_msg(m["message"]),
        ]
        for f in eslint
        for m in f["messages"]
        if m.get("ruleId")
    ]
    if rows:
        lines += ["## JS complexity issues (sonarjs)", table(["File", "Rule", "Line", "Detail"], rows), ""]

    print("\n".join(lines))


if __name__ == "__main__":
    main()
