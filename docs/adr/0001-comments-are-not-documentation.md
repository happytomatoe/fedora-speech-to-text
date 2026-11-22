# 0001 — Comments are not documentation

- Status: Accepted
- Date: 2026-11-22

## Context

Code comments in this repository duplicated the code, described implementations that had
already changed, and — most damaging — rationalised shortcuts so that the next reader treated
the shortcut as intentional design.

The alternatives were: keep commenting conventions and police their quality by review, or
remove comments from code entirely and keep only the decisions that cannot be recovered from
the code. Review cannot police a category that has no definition, and every comment is a second
copy of the truth that can drift.

## Decision

Code files carry no comments. The single exception is machine directives (`# noqa`,
`# type: ignore`, `pyright:`, `@ts-expect-error`, `eslint-disable`, `shellcheck`, shebang,
SPDX). Docstrings and JSDoc blocks are API documentation and are not comments.

A comment that would have explained *why* is written as an ADR in this directory instead. The
ADR is linked from the commit message and, when it is load-bearing for a single module, from that
module's docstring.

Tests follow the same rule. A test whose intent is not obvious from its name and assertions is
a badly named test, not a comment opportunity.

## Consequences

- Removing a comment while editing code is always allowed; adding one is a lint failure.
- Decisions that used to be inline are now discoverable in one place and have a status.
- Reviewers ask for an ADR when a change needs justification, instead of asking for a comment.
- Git history holds the "what changed"; ADRs hold the "why".

## Enforcement

`scripts/check-comments.py` counts non-directive comments per file and compares them with
`comment-budget.json`. A file absent from the budget must have zero comments. `--update` lowers
a budget and refuses to raise it, so the remaining comment count is a ratchet: it can only fall.

`lint-rules/no-comments.js` is the oxlint rule for `gnome-ext/**/*.js`; it reports every
non-directive comment that is not a JSDoc block. `gnome-ext` is fully migrated, so the rule runs
with no exemptions there.

Files outside the enforced scope (`docs/`, `justfile`, lockfiles) are documentation or build
configuration, not code.
