# 0012 — Repository tooling contracts

- Status: Accepted
- Date: 2026-11-22

## Context

The `scripts/` helpers are part of CI and the developer workflow. Several protocols and
heuristics were documented only as comments inside the scripts.

## Decisions

### 1. `ego-lint` exit and output contract

`ego-lint` runs every EGO compliance check for an extension directory (default: cwd) and exits
`0` only when no FAIL finding exists, `1` when at least one does. CI gating depends on this; the
exit code must not be reused for tooling errors, which exit `2`.

`--show` takes a comma-separated, case-insensitive severity list. The default is `fail,warn`;
`all` expands to the four concrete levels. Any other value is a usage error, not silently
ignored. The banner, code metrics and report chrome are emitted only when all four levels are
selected, which is why `SHOW_ALL` checks for each level rather than the literal `all`.

Console output is fixed-width (`[STATUS] check-name detail`) and strips the `|fix:` suffix; the
results file keeps it so `--report` can print fix suggestions. Sub-scripts communicate with
exactly three pipe-delimited fields (`STATUS|check-name|detail`), and `detail` may carry a
`|fix:` suffix. Changing that encoding requires updating every `check-*` producer.

Whitespace is trimmed with parameter expansion, not `xargs`, because `xargs` re-parses quotes and
corrupts details containing apostrophes.

### 2. `ego-lint` detection heuristics

- R-SLOP-01/02 WARNs are deferred until `check-quality.py` has produced the provenance score;
  printing immediately would make post-hoc suppression impossible and double-count the WARNs.
  A score of 3 or more (domain vocabulary, nontrivial algorithms) treats JSDoc as intentional;
  AI-generated code typically scores 1–2.
- esbuild helper names (`__defProp`, `__decorateClass`, `__publicField`) mark transpiled output.
  When present, transpiler-artifact rules are suppressed, resource tracking and
  `no-destroy-method` are skipped, and file-structure checks are relaxed. This detection must run
  before the file-structure checks.
- A `tsconfig.json` at the extension root or in `src/` marks a TypeScript project; tsc emits
  JSDoc-style `@param`/`@returns`, which must not count as AI slop.
- SPDX headers on at least 70% of JS files suppress R-SLOP-01/02 as intentional. The 70% is a
  deliberate heuristic, not a number to tune without evidence.
- A top-level directory whose JS entry point starts with `#!/usr/bin/env gjs` is a GJS subprocess,
  not extension code, and is excluded from Shell-specific checks. This must stay in sync with
  `_discover_subprocess_dirs()` in the Python checks.
- File-structure checks are skipped for compiled TypeScript, whose bundled layout is legitimately
  non-standard; the `compiled-typescript` WARN already reports it.
- Only `console.log` is flagged in extension JS (not `debug`/`warn`/`error`), and matches inside
  comments are ignored.
- Minification requires at least three lines longer than 500 characters; one long line (for
  example a keyboard-constant chain) is not minification.
- The ESLint summary is parsed from the `stylish` formatter's `X problems (Y errors, Z warnings)`
  line. A different formatter needs a different parser.

### 3. Dev session isolation

`scripts/gnome-ext-dev-session.sh` is launched by `just dev` inside `dbus-run-session`. It starts
AT-SPI, the D-Bus service, enables the extension in the isolated dconf and launches a nested
GNOME Shell. Running it in the user's session would touch real shell/dconf state. It removes
`/run/user/<uid>/gnome-shell-disable-extensions` first, because that file makes the shell start
with every extension disabled.

### 4. Commit-message hook contract

`scripts/no-co-authored-by.sh` is installed as a `commit-msg` hook and receives the commit-message
file path as `$1`. It enforces the policy that forbids `Co-Authored-By:` trailers. The argument
contract is fixed by git's hook interface.

### 5. `no-silent-catch` rule semantics

Every `catch` body and promise `.catch()` handler must contain a `console.*` call or a top-level
rethrow; a comment alone does not satisfy it. The AST walk stops at nested function and class
bodies, because a `console` call inside a callback that may never run does not prove the catch
path is loud.

### 6. Output-method sync check

Supported output methods are normally found from literal `output_method == "..."` comparisons in
the engine; the `use_typing` branch contributes `type` and `mutter-virtual`, which have no such
comparison, so an extra extraction step exists. The check compares the engine, the preferences
combo box and the GSettings default, and is also run from `just lint`.

## Consequences

Script output is a machine interface. Any change to a field, exit code or severity set is a
breaking change for CI and for the other scripts.
