#!/usr/bin/env python3
"""Generate an enhanced HTML report from SonarQube JSON exports.

Features:
- Expandable issue cards with code snippets
- Syntax-highlighted source code with line markers
- Rule descriptions (what/why/how to fix)
- Dark theme, filterable, responsive
"""

import html
import json
import sys
from collections import defaultdict
from pathlib import Path


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)


def severity_color(sev: str) -> str:
    return {
        "BLOCKER": "#e74c3c",
        "CRITICAL": "#e67e22",
        "MAJOR": "#f39c12",
        "MINOR": "#3498db",
        "INFO": "#95a5a6",
    }.get(sev, "#95a5a6")


def severity_icon(sev: str) -> str:
    return {
        "BLOCKER": "🔴",
        "CRITICAL": "🟠",
        "MAJOR": "🟡",
        "MINOR": "🔵",
        "INFO": "⚪",
    }.get(sev, "⚪")


def rating_letter(val: str) -> str:
    return {"1.0": "A", "2.0": "B", "3.0": "C", "4.0": "D", "5.0": "E"}.get(val, val)


def rating_color(val: str) -> str:
    return {
        "1.0": "#27ae60",
        "2.0": "#2ecc71",
        "3.0": "#f39c12",
        "4.0": "#e67e22",
        "5.0": "#e74c3c",
    }.get(val, "#95a5a6")


def get_source_snippet(
    sources: dict, component: str, line: int, text_range: dict | None = None, context: int = 5
) -> list[dict]:
    """Get source lines around an issue from cached sources."""
    if not component or not line:
        return []

    tr = text_range or {}
    start_line = tr.get("startLine", line) or line
    end_line = tr.get("endLine", line) or line
    range_start = max(1, start_line - context)

    # Find matching source block
    for key, block in sources.items():
        if block.get("component") == component and block.get("start") == range_start:
            result = []
            for ln in block.get("lines", []):
                lnum = ln.get("line", 0)
                code = ln.get("code", "")
                result.append({
                    "line": lnum,
                    "code": code,
                    "isIssue": start_line <= lnum <= end_line,
                })
            return result
    return []


def render_code_snippet(lines: list[dict], issue_line: int, component: str) -> str:
    """Render source lines as a styled code block."""
    if not lines:
        return ""

    filename = component.rsplit(":", maxsplit=1)[-1] if ":" in component else component
    rows = ""
    for ln in lines:
        lnum = ln["line"]
        code = ln["code"]
        is_issue = ln["isIssue"]

        row_class = "code-issue-line" if is_issue else "code-line"
        marker = "➤" if is_issue else "&nbsp;"

        rows += f"""<tr class="{row_class}">
          <td class="ln-marker">{marker}</td>
          <td class="ln-num">{lnum}</td>
          <td class="ln-code">{code}</td>
        </tr>"""

    return f"""<div class="code-block">
      <div class="code-header">
        <span class="code-filename">📄 {html.escape(filename)}</span>
        <span class="code-line-ref">Line {issue_line}</span>
      </div>
      <div class="code-scroll">
        <table class="code-table"><tbody>{rows}</tbody></table>
      </div>
    </div>"""


def render_rule_description(rule: dict) -> str:
    """Render rule description sections."""
    sections = []
    if rule.get("root_cause"):
        sections.append(("❓ What is the issue?", rule["root_cause"]))
    if rule.get("how_to_fix"):
        sections.append(("🔧 How to fix it", rule["how_to_fix"]))
    if rule.get("assess"):
        sections.append(("🔍 Why is this an issue?", rule["assess"]))
    if rule.get("htmlDesc") and not sections:
        sections.append(("📖 Rule description", rule["htmlDesc"]))

    if not sections:
        return ""

    items = ""
    for title, content in sections:
        items += f"""<div class="desc-section">
          <div class="desc-title">{title}</div>
          <div class="desc-body">{content}</div>
        </div>"""

    return f'<div class="rule-desc">{items}</div>'


def generate_html(reports_dir: Path) -> str:
    metrics = load_json(reports_dir / "metrics.json")
    issues_data = load_json(reports_dir / "issues.json")
    quality_gate = load_json(reports_dir / "quality-gate.json")
    rules_data = load_json(reports_dir / "rules.json")
    sources_data = load_json(reports_dir / "sources.json")

    # Build rules lookup
    rules_by_key = {r["key"]: r for r in rules_data if isinstance(r, dict) and "key" in r}

    # Parse metrics
    measures = {}
    for m in metrics.get("component", {}).get("measures", []):
        measures[m["metric"]] = m["value"]

    gate_status = quality_gate.get("projectStatus", {}).get("status", "UNKNOWN")

    # Parse issues
    issues = issues_data.get("issues", [])
    by_severity = defaultdict(list)
    by_file = defaultdict(list)
    by_type = defaultdict(list)
    for issue in issues:
        sev = issue.get("severity", "UNKNOWN")
        comp = issue.get("component", "").split(":")[-1]
        by_severity[sev].append(issue)
        by_file[comp].append(issue)
        by_type[issue.get("type", "UNKNOWN")].append(issue)

    severity_order = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"]

    # Build issue cards
    issue_cards = ""
    for idx, sev in enumerate(severity_order):
        for issue in by_severity.get(sev, []):
            comp = issue.get("component", "")
            short_comp = comp.split(":")[-1] if ":" in comp else comp
            line = issue.get("line", "?")
            msg = html.escape(issue.get("message", ""))
            rule_key = issue.get("rule", "")
            itype = issue.get("type", "")
            effort = issue.get("effort", "")
            text_range = issue.get("textRange")
            color = severity_color(sev)
            icon = severity_icon(sev)

            # Get source snippet
            snippet_lines = get_source_snippet(sources_data, comp, line, text_range)
            code_snippet = render_code_snippet(snippet_lines, line, comp)

            # Get rule description
            rule = rules_by_key.get(rule_key, {})
            rule_desc = render_rule_description(rule)

            card_id = f"issue-{idx}"
            issue_cards += f"""
            <div class="issue-card" data-severity="{sev}" data-type="{itype}" data-file="{html.escape(short_comp)}">
              <div class="issue-header" onclick="toggleCard('{card_id}')">
                <div class="issue-header-left">
                  <span class="badge" style="background:{color}">{icon} {sev}</span>
                  <span class="badge type-{itype.lower()}">{itype}</span>
                  <span class="issue-location">{html.escape(short_comp)}:{line}</span>
                </div>
                <div class="issue-header-right">
                  <span class="issue-effort">{effort}</span>
                  <span class="expand-icon" id="icon-{card_id}">▶</span>
                </div>
              </div>
              <div class="issue-body" id="{card_id}" style="display:none">
                <div class="issue-message">{msg}</div>
                <div class="issue-rule"><small class="rule">Rule: {rule_key}</small></div>
                {code_snippet}
                {rule_desc}
              </div>
            </div>"""

    # File breakdown
    file_rows = ""
    for f in sorted(by_file.keys()):
        file_issues = by_file[f]
        critical = sum(1 for i in file_issues if i.get("severity") in ("BLOCKER", "CRITICAL"))
        major = sum(1 for i in file_issues if i.get("severity") == "MAJOR")
        minor = sum(1 for i in file_issues if i.get("severity") in ("MINOR", "INFO"))
        file_rows += f"""
            <tr onclick="filterByFile('{html.escape(f)}')" class="clickable">
                <td class="file-link">{html.escape(f)}</td>
                <td>{len(file_issues)}</td>
                <td>{"🔴 " + str(critical) if critical else ""}</td>
                <td>{"🟠 " + str(major) if major else ""}</td>
                <td>{"🔵 " + str(minor) if minor else ""}</td>
            </tr>"""

    # Metrics cards
    def metric(label, key, convert=None):
        val = measures.get(key, "—")
        if convert:
            val = convert(val)
        return f'<div class="card"><div class="card-value">{val}</div><div class="card-label">{label}</div></div>'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SonarQube Report — voice-to-text</title>
<style>
  :root {{ --bg: #1a1a2e; --surface: #16213e; --surface2: #0f3460; --text: #e0e0e0; --text2: #a0a0a0; --accent: #533483; }}
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 24px; line-height: 1.6; }}
  h1 {{ font-size: 1.8rem; margin-bottom: 8px; }}
  h2 {{ font-size: 1.3rem; margin: 32px 0 16px; color: var(--text2); }}
  .subtitle {{ color: var(--text2); margin-bottom: 24px; }}

  .gate {{ display: inline-block; padding: 8px 20px; border-radius: 8px; font-weight: 700; font-size: 1.1rem; margin-bottom: 24px; }}
  .gate-OK {{ background: #27ae60; color: #fff; }}
  .gate-KO {{ background: #e74c3c; color: #fff; }}

  .metrics {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 32px; }}
  .card {{ background: var(--surface); border-radius: 10px; padding: 16px; text-align: center; }}
  .card-value {{ font-size: 1.8rem; font-weight: 700; }}
  .card-label {{ font-size: 0.8rem; color: var(--text2); margin-top: 4px; }}

  .tabs {{ display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }}
  .tab {{ padding: 8px 16px; border-radius: 8px; background: var(--surface); color: var(--text2); cursor: pointer; border: none; font-size: 0.9rem; }}
  .tab.active {{ background: var(--accent); color: #fff; }}

  table {{ width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 10px; overflow: hidden; }}
  th {{ background: var(--surface2); padding: 12px 16px; text-align: left; font-size: 0.85rem; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; }}
  td {{ padding: 10px 16px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 0.9rem; vertical-align: top; }}
  tr:hover {{ background: rgba(255,255,255,0.03); }}
  .clickable {{ cursor: pointer; }}

  .badge {{ display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; color: #fff; white-space: nowrap; }}
  .type-bug {{ background: #e74c3c; }}
  .type-vulnerability {{ background: #e67e22; }}
  .type-code_smell {{ background: #3498db; }}
  .type-security_hotspot {{ background: #9b59b6; }}

  .file-link {{ color: #5dade2; cursor: pointer; }}
  .file-link:hover {{ text-decoration: underline; }}
  .rule {{ color: var(--text2); }}

  .filter-bar {{ display: flex; gap: 12px; margin-bottom: 16px; align-items: center; }}
  .filter-bar input {{ padding: 8px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: var(--surface); color: var(--text); font-size: 0.9rem; width: 300px; }}
  .filter-bar button {{ padding: 8px 14px; border-radius: 8px; border: none; background: var(--accent); color: #fff; cursor: pointer; font-size: 0.9rem; }}

  /* Issue cards */
  .issue-card {{ background: var(--surface); border-radius: 10px; margin-bottom: 12px; overflow: hidden; border: 1px solid rgba(255,255,255,0.05); }}
  .issue-header {{ display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; cursor: pointer; }}
  .issue-header:hover {{ background: rgba(255,255,255,0.03); }}
  .issue-header-left {{ display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }}
  .issue-header-right {{ display: flex; gap: 12px; align-items: center; }}
  .issue-location {{ color: #5dade2; font-family: monospace; font-size: 0.85rem; }}
  .issue-effort {{ color: var(--text2); font-size: 0.85rem; }}
  .expand-icon {{ color: var(--text2); transition: transform 0.2s; }}
  .expand-icon.open {{ transform: rotate(90deg); }}
  .issue-body {{ padding: 0 16px 16px; border-top: 1px solid rgba(255,255,255,0.05); }}
  .issue-message {{ padding: 12px 0; font-size: 0.95rem; }}
  .issue-rule {{ padding-bottom: 8px; }}

  /* Code blocks */
  .code-block {{ background: #0d1117; border-radius: 8px; margin: 12px 0; overflow: hidden; }}
  .code-header {{ display: flex; justify-content: space-between; padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; }}
  .code-filename {{ color: #e6edf3; font-size: 0.85rem; }}
  .code-line-ref {{ color: #8b949e; font-size: 0.85rem; }}
  .code-scroll {{ overflow-x: auto; max-height: 400px; overflow-y: auto; }}
  .code-table {{ width: 100%; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.8rem; }}
  .code-table td {{ padding: 2px 12px; border: none; white-space: pre; }}
  .code-line {{ color: #8b949e; }}
  .code-issue-line {{ background: rgba(255, 100, 100, 0.15); }}
  .ln-marker {{ color: #f97583; width: 24px; text-align: center; }}
  .ln-num {{ color: #8b949e; width: 50px; text-align: right; padding-right: 12px; user-select: none; }}
  .ln-code {{ color: #e6edf3; }}

  /* Rule description */
  .rule-desc {{ margin-top: 12px; }}
  .desc-section {{ margin-bottom: 12px; }}
  .desc-title {{ font-weight: 600; margin-bottom: 4px; color: #e0e0e0; }}
  .desc-body {{ color: #a0a0a0; font-size: 0.9rem; }}
  .desc-body code {{ background: #1e293b; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.85rem; }}

  .hidden {{ display: none; }}
</style>
</head>
<body>
<h1>📊 SonarQube Report</h1>
<div class="subtitle">voice-to-text · Generated from sonar-reports/</div>

<div class="gate gate-{gate_status}">Quality Gate: {gate_status}</div>

<div class="metrics">
  {metric("Lines of Code", "ncloc")}
  {metric("Bugs", "bugs")}
  {metric("Vulnerabilities", "vulnerabilities")}
  {metric("Code Smells", "code_smells")}
  {metric("Security Hotspots", "security_hotspots")}
  {metric("Coverage", "coverage", lambda v: v + "%")}
  {metric("Duplications", "duplicated_lines_density", lambda v: v + "%")}
  {metric("Security", "security_rating", rating_letter)}
  {metric("Reliability", "reliability_rating", rating_letter)}
  {metric("Maintainability", "sqale_rating", rating_letter)}
</div>

<h2>Issues ({len(issues)})</h2>

<div class="filter-bar">
  <input type="text" id="search" placeholder="Filter by file, rule, or message..." oninput="filterCards()">
  <button onclick="clearFilter()">Clear</button>
  <button onclick="expandAll()">Expand All</button>
  <button onclick="collapseAll()">Collapse All</button>
</div>

<div id="issues-container">
{issue_cards}
</div>

<h2>Files ({len(by_file)})</h2>
<table id="files-table">
<thead>
<tr><th>File</th><th>Issues</th><th>Critical</th><th>Major</th><th>Minor</th></tr>
</thead>
<tbody>
{file_rows}
</tbody>
</table>

<script>
function toggleCard(id) {{
  const el = document.getElementById(id);
  const icon = document.getElementById('icon-' + id);
  if (el.style.display === 'none') {{
    el.style.display = 'block';
    icon.classList.add('open');
  }} else {{
    el.style.display = 'none';
    icon.classList.remove('open');
  }}
}}

function expandAll() {{
  document.querySelectorAll('.issue-body').forEach(el => el.style.display = 'block');
  document.querySelectorAll('.expand-icon').forEach(el => el.classList.add('open'));
}}

function collapseAll() {{
  document.querySelectorAll('.issue-body').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.expand-icon').forEach(el => el.classList.remove('open'));
}}

function filterCards() {{
  const q = document.getElementById('search').value.toLowerCase();
  document.querySelectorAll('.issue-card').forEach(card => {{
    const text = card.textContent.toLowerCase();
    const file = card.dataset.file || '';
    card.style.display = (text.includes(q) || file.toLowerCase().includes(q)) ? '' : 'none';
  }});
}}

function clearFilter() {{
  document.getElementById('search').value = '';
  filterCards();
}}

function filterByFile(file) {{
  document.getElementById('search').value = file;
  filterCards();
  document.getElementById('issues-container').scrollIntoView({{ behavior: 'smooth' }});
}}
</script>
</body>
</html>"""


def main():
    reports_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("sonar-reports")
    output = reports_dir / "report.html"
    html_content = generate_html(reports_dir)
    output.write_text(html_content)
    print(f"HTML report written to {output}")


if __name__ == "__main__":
    main()
