#!/usr/bin/env python3
"""Enforce the comment budget in code files.

Policy: comments are not documentation. A comment that explains *why* belongs
in an ADR (docs/adr/); a comment that explains *what* is a tautology.

Docstrings and JSDoc blocks are documentation, not comments, and are ignored.
Directive comments (noqa, type: ignore, eslint-disable, @ts-*, shellcheck,
shebang, SPDX) are mechanical and are ignored.

Every file not listed in comment-budget.json must have zero comments. Files
listed there may keep at most their recorded count; `--update` only lowers a
budget, so the total can never grow.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUDGET_FILE = ROOT / "comment-budget.json"

SCOPE = [
    ("src/**/*.py", None),
    ("tests/**/*.py", None),
    ("gnome-ext/**/*.js", "gnome-ext/vendor"),
    ("gnome-ext/**/*.css", "gnome-ext/vendor"),
    ("scripts/**/*", None),
    ("service/**/*", None),
    ("lint-rules/**/*.js", None),
    ("e2e/**/*.ts", "e2e/node_modules"),
]

ALLOWED = [
    re.compile(r"^#!.*"),
    re.compile(r"^#\s*(-\*-\s*coding:|noqa|type:|pyright:|pragma:|fmt:|isort:|ruff:|shellcheck|SPDX|Copyright)"),
    re.compile(r"^//\s*(@ts-(check|expect-error|ignore|nocheck)|eslint-|oxlint-|prettier-|aislop-)"),
    re.compile(r"^/\*!"),
]


def is_directive(text: str) -> bool:
    """Return True for machine directives that must stay in the source."""
    return any(pattern.match(text) for pattern in ALLOWED)


def scan_python(path: Path) -> list[tuple[int, str]]:
    """Return non-directive comment tokens in a Python file."""
    source = path.read_text(encoding="utf-8")
    return [
        (token.start[0], token.string)
        for token in tokenize.generate_tokens(io.StringIO(source).readline)
        if token.type == tokenize.COMMENT and not is_directive(token.string)
    ]


JS_SUFFIXES = {".js", ".ts", ".mjs", ".cjs", ".css"}


def _skip_quoted(source: str, index: int, line: int, quote: str) -> tuple[int, int]:
    """Skip a quoted string or template literal, returning the new index and line."""
    index += 1
    while index < len(source):
        if source[index] == "\\":
            index += 2
            continue
        if source[index] == quote:
            return index + 1, line
        if source[index] == "\n":
            line += 1
        index += 1
    return index, line


def _skip_regex(source: str, index: int) -> int:
    """Skip a regular-expression literal, returning the new index."""
    index += 1
    while index < len(source):
        if source[index] == "\\":
            index += 2
            continue
        if source[index] in "/\n":
            return index + 1
        index += 1
    return index


def scan_c_like(path: Path) -> list[tuple[int, str]]:
    """Return non-directive line and block comments in a JS/TS/CSS file."""
    source = path.read_text(encoding="utf-8")
    found = []
    index = 0
    line = 1
    while index < len(source):
        if source[index] == "\n":
            line += 1
            index += 1
        elif source.startswith("//", index):
            end = source.find("\n", index)
            end = len(source) if end == -1 else end
            text = source[index:end]
            if not is_directive(text):
                found.append((line, text))
            index = end
        elif source.startswith("/*", index):
            start_line = line
            end = source.find("*/", index + 2)
            end = len(source) if end == -1 else end + 2
            text = source[index:end]
            line += text.count("\n")
            if not text.startswith("/**") and not is_directive(text):
                found.append((start_line, text.split("\n")[0]))
            index = end
        elif source[index] in "'\"`":
            index, line = _skip_quoted(source, index, line, source[index])
        elif source[index] == "/" and _starts_regex(source, index):
            index = _skip_regex(source, index)
        else:
            index += 1
    return found


def _starts_regex(source: str, index: int) -> bool:
    """Heuristically decide whether the slash at `index` opens a regex literal."""
    previous = index - 1
    while previous >= 0 and source[previous] in " \t\n":
        previous -= 1
    if previous < 0:
        return True
    return source[previous] in "(,=:[!&|?{};+-*%~^<>"


def scan_shell(path: Path) -> list[tuple[int, str]]:
    """Return non-directive comments in a shell script."""
    found = []
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if raw.startswith("#!"):
            continue
        in_single = in_double = False
        index = 0
        while index < len(raw):
            char = raw[index]
            if char == "\\" and not in_single:
                index += 2
                continue
            if char == "'" and not in_double:
                in_single = not in_single
            elif char == '"' and not in_single:
                in_double = not in_double
            elif char == "#" and not in_single and not in_double and (index == 0 or raw[index - 1] in " \t"):
                text = raw[index:]
                if not is_directive(text):
                    found.append((number, text))
                break
            index += 1
    return found


def scan(path: Path) -> list[tuple[int, str]]:
    """Dispatch to the scanner for the file's language."""
    if path.suffix == ".py":
        return scan_python(path)
    if path.suffix in JS_SUFFIXES:
        return scan_c_like(path)
    first = path.read_text(encoding="utf-8", errors="replace").split("\n", 1)[0]
    if first.startswith("#!"):
        return scan_shell(path)
    return []


def discover() -> list[Path]:
    """Return every file covered by the comment budget."""
    files: set[Path] = set()
    for pattern, excluded in SCOPE:
        for path in ROOT.glob(pattern):
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            if excluded and str(path.relative_to(ROOT)).startswith(excluded):
                continue
            files.add(path)
    return sorted(files)


def load_budget() -> dict[str, int]:
    """Read the current per-file budgets."""
    if not BUDGET_FILE.exists():
        return {}
    return json.loads(BUDGET_FILE.read_text(encoding="utf-8"))["files"]


def main() -> int:
    """Compare comments against the budget; return a process exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="lower budgets to the current counts")
    parser.add_argument("--force", action="store_true", help="allow --update to raise a budget")
    parser.add_argument("--list", action="store_true", help="print every file with a non-zero count")
    args = parser.parse_args()

    budget = load_budget()
    counts = {str(path.relative_to(ROOT)): len(scan(path)) for path in discover()}
    counts = {name: count for name, count in counts.items() if count}

    if args.list:
        for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
            print(f"{count:5d}  {name}  (budget {budget.get(name, 0)})")
        return 0

    if args.update:
        updated = {}
        for name, count in counts.items():
            previous = budget.get(name, 0)
            value = previous if count > previous and not args.force and name in budget else count
            updated[name] = value
        BUDGET_FILE.write_text(
            json.dumps({"policy": "docs/adr/0001-comments-are-not-documentation.md", "files": updated}, indent=2)
            + "\n",
            encoding="utf-8",
        )
        print(f"comment budget updated: {len(updated)} files, {sum(updated.values())} comments")
        return 0

    failures = []
    for name, count in counts.items():
        allowed = budget.get(name, 0)
        if count > allowed:
            failures.append((name, count, allowed))
    for name, count, allowed in failures:
        print(f"{name}: {count} comments, budget {allowed} (delete {count - allowed})")
    if failures:
        print("Delete the comments, or move the decision to docs/adr/. See the policy ADR.")
        return 1
    print(f"comment budget OK: {sum(counts.values())} comments in {len(counts)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
