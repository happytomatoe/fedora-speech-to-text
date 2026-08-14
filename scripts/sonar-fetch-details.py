#!/usr/bin/env python3
"""Fetch rule details and source code snippets from SonarQube for HTML report."""

import base64
import json
import sys
import urllib.request
from pathlib import Path


def fetch_rules(base_url: str, user: str, pw: str, rule_keys: list[str], out_path: Path) -> None:
    """Fetch rule details for each rule key."""
    cred = base64.b64encode(f"{user}:{pw}".encode()).decode()
    rules_out = []

    for rule_key in rule_keys:
        try:
            req = urllib.request.Request(f"{base_url}/api/rules/show?key={rule_key}")
            req.add_header("Authorization", f"Basic {cred}")
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
                rule = data.get("rule", {})
                # Extract description sections
                sections: dict[str, dict[str, str]] = {}
                for sec in rule.get("descriptionSections", []):
                    k = sec.get("key", "")
                    ctx = (sec.get("context") or {}).get("key", "default")
                    sections.setdefault(k, {})[ctx] = sec.get("content", "")
                flat = {k: v.get("default") or next(iter(v.values()), "") for k, v in sections.items()}
                rules_out.append(
                    {
                        "key": rule_key,
                        "name": rule.get("name", rule_key),
                        "severity": rule.get("severity", ""),
                        "htmlDesc": rule.get("htmlDesc", ""),
                        "root_cause": flat.get("root_cause", ""),
                        "how_to_fix": flat.get("how_to_fix", ""),
                        "assess": flat.get("assess_the_problem", ""),
                        "tags": rule.get("tags", []) + rule.get("sysTags", []),
                    }
                )
        except Exception as e:
            print(f"Warning: failed to fetch rule {rule_key}: {e}", file=sys.stderr)

    out_path.write_text(json.dumps(rules_out, indent=2))
    print(f"Fetched {len(rules_out)} rules")


def fetch_sources(base_url: str, user: str, pw: str, issues_path: Path, out_path: Path, context: int = 5) -> None:
    """Fetch source code snippets for each issue."""
    cred = base64.b64encode(f"{user}:{pw}".encode()).decode()
    issues = json.loads(issues_path.read_text()).get("issues", [])
    sources: dict[str, dict] = {}

    for issue in issues:
        comp = issue.get("component", "")
        line = issue.get("line")
        tr = issue.get("textRange", {})
        if not comp or not line:
            continue
        start = max(1, (tr.get("startLine", line) or line) - context)
        end = (tr.get("endLine", line) or line) + context
        cache_key = f"{comp}:{start}:{end}"
        if cache_key in sources:
            continue
        try:
            url = f"{base_url}/api/sources/lines?key={comp}&from={start}&to={end}"
            req = urllib.request.Request(url)
            req.add_header("Authorization", f"Basic {cred}")
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
                sources[cache_key] = {
                    "component": comp,
                    "start": start,
                    "end": end,
                    "lines": data.get("sources", []),
                }
        except Exception as e:
            print(f"Warning: failed to fetch source for {comp}:{start}-{end}: {e}", file=sys.stderr)

    out_path.write_text(json.dumps(sources, indent=2))
    print(f"Fetched {len(sources)} source blocks")


def main() -> None:
    if len(sys.argv) < 5:
        print("Usage: sonar-fetch-details.py <reports_dir> <base_url> <user> <pw>")
        sys.exit(1)

    reports_dir = Path(sys.argv[1])
    base_url = sys.argv[2]
    user = sys.argv[3]
    pw = sys.argv[4]

    issues_path = reports_dir / "issues.json"
    if not issues_path.exists():
        print("No issues.json found, skipping")
        return

    issues = json.loads(issues_path.read_text()).get("issues", [])
    rule_keys = list({i["rule"] for i in issues if "rule" in i})

    fetch_rules(base_url, user, pw, rule_keys, reports_dir / "rules.json")
    fetch_sources(base_url, user, pw, issues_path, reports_dir / "sources.json")


if __name__ == "__main__":
    main()
