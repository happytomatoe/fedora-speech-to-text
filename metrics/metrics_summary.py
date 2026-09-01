"""Render a formatted summary table from the reports in metrics-report/."""

import json
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


def top_lines(name, n=5):
    lines = (REPORTS / name).read_text().splitlines()
    return lines[:n]


def main():
    lines = ["# Metrics Summary", ""]

    # Python SLOC (radon raw)
    raw = load_json("radon-raw.json")
    tot = {k: sum(f.get(k, 0) for f in raw.values()) for k in ("loc", "sloc", "comments", "blank")}

    # Python cyclomatic (radon cc)
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

    # Python cognitive (complexipy)
    cog = load_json("complexipy-results.json")
    cog_scores = [f["complexity"] for f in cog]

    # Coverage
    cov = ET.parse(REPORTS / "coverage.xml").getroot()
    line_rate = float(cov.attrib["line-rate"])

    # CRAP
    crap = load_json("crap.json")

    # JS LOC
    js_loc_lines = top_lines("js-loc.txt")
    js_total = next(int(x.split()[0]) for x in js_loc_lines if "total" in x)

    # JS complexity (sonarjs via eslint)
    eslint = load_json("eslint-complexity.json")
    js_issues = sum(len(f["messages"]) for f in eslint)

    # Duplication (jscpd)
    jscpd = load_json("jscpd/jscpd-report.json")["statistics"]["total"]

    # Pyright / Any
    pyright = load_json("any-unknown-count.json")["pyright_summary"]

    overview = table(
        ["Metric", "Value"],
        [
            ["Python LOC", tot["loc"]],
            ["Python SLOC", tot["sloc"]],
            ["Python comments", tot["comments"]],
            ["JS LOC", js_total],
            ["Python functions", len(funcs)],
            ["Avg cyclomatic (py)", round(sum(ccs) / len(ccs), 1)],
            ["Max cyclomatic (py)", max(ccs)],
            ["Cyclomatic > 10 (py)", sum(1 for c in ccs if c > 10)],
            ["Avg cognitive (py)", round(sum(cog_scores) / len(cog_scores), 1)],
            ["Cognitive > 10 (py)", sum(1 for c in cog_scores if c > 10)],
            ["JS complexity issues (sonarjs)", js_issues],
            ["Coverage", f"{line_rate * 100:.1f}% (target 80%, not enforced)"],
            ["CRAP > 30 (py)", sum(1 for c in crap if c["crap"] > 30)],
            ["Duplicated lines (jscpd)", f"{jscpd['duplicatedLines']} ({jscpd['percentage']:.2f}%)"],
            ["Pyright errors", pyright["errorCount"]],
            ["Vulture findings", len(top_lines("vulture.txt"))],
            ["Knip findings", len(top_lines("knip.txt"))],
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

    rows = [[f["filePath"].split("/")[-1], m["ruleId"], m["line"]] for f in eslint for m in f["messages"]][:5]
    if rows:
        lines += ["## JS complexity issues (sonarjs, top 5)", table(["File", "Rule", "Line"], rows), ""]

    print("\n".join(lines))


if __name__ == "__main__":
    main()
