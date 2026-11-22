---
name: delete-comment
description: Audit and delete code comments in this repository, move decision records to ADRs, file issues for comments that excuse hacks, and ratchet the comment budget down. Use when asked to clean up comments, when adding a comment is tempting, or when the comment-budget check fails.
---

# Delete comments

The policy is `docs/adr/0001-comments-are-not-documentation.md`: code files carry no comments
except machine directives; a *why* becomes an ADR under `docs/adr/`; a *what* is deleted.

## 1. Measure

```sh
python3 scripts/check-comments.py --list
```

This prints every file with a non-directive comment count and its current budget. Files absent
from `comment-budget.json` must have zero. Docstrings, JSDoc `/** */`, shebangs and directives
(`noqa`, `type: ignore`, `pyright:`, `@ts-*`, `eslint-*`, `aislop-*`, `shellcheck`, SPDX) are not
counted.

When auditing a subtree, run the linter with that file as the unit rather than eyeballing a grep;
grep matches `#` and `//` inside strings.

## 2. Classify every comment

One bucket per comment, no exceptions:

| Bucket | Test | Action |
|---|---|---|
| Tautology | repeats the code, names a section, narrates steps (`# 1. ...`), labels an obvious expression | delete |
| Stale | references removed code, a missing plan file, an old mechanism | delete |
| Excuse | makes a hack, workaround, disabled check, test-only production path, or heuristic look intentional | delete + file an issue |
| Decision Record | a non-obvious constraint, protocol quirk, race/ordering requirement, security rule | delete + write an ADR |

Tie-breaker: if deleting the comment would make a maintainer likely to "fix" the code the wrong
way, it is a Decision Record.

Verify staleness before deleting: check that a referenced file or symbol really is gone. A TODO
whose plan file does not exist is stale; a TODO with a live issue is a decision to keep working,
so convert it to an ADR entry or an issue and delete the comment.

## 3. Apply

- Edit only comment lines; never reformat, rename or reorder code.
- Never delete `#`/`//` text inside strings, heredocs, `echo` lines, URL literals or regexes.
- Keep every directive line verbatim, including its trailing explanation.
- Collapse blank-line runs left behind (maximum one blank line).
- Group related decision records into one ADR by theme; number files sequentially in
  `docs/adr/`, and date them.
- File one issue per excuse with: the site, why it matters, and the correct fix. Search open
  issues first (`gh issue list --search "<keywords> in:title,body"`).
- Parallelise by disjoint area (for example `src/`, `gnome-ext/`, `scripts/`, `tests/`); never let
  two workers edit the same file.

## 4. Ratchet

```sh
python3 scripts/check-comments.py --update           # lowers budgets to current counts
python3 scripts/check-comments.py                    # must pass
```

`--update` refuses to raise an existing budget, so the count can only fall. Do not use `--force`
to make a failure disappear; delete the comment instead.

## 5. Verify

```sh
python3 scripts/check-comments.py
uv run ruff check .
uv run ruff format --check .
npx oxlint gnome-ext/
uv run pytest -n auto
```

`lint-rules/no-comments.js` fails any non-directive comment in `gnome-ext/**/*.js`. For Python the
budget check is the enforcement; there is no ruff rule that can ban comments.

## 6. When a comment is tempting

Do not add it. Do one of:

- Rename the variable/function so the comment is unnecessary.
- Extract a named constant or helper for a magic value.
- Write an ADR and link it from the module docstring.
- File an issue if the code needs a real fix but cannot be fixed now.
