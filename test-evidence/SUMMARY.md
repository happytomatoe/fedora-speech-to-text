# Test Evidence — 2026-07-26

## Python Test Suite

- **Command:** `just test`
- **Result:** ✅ 93 passed, 0 failed, 56 warnings
- **Duration:** ~5s
- **Exit code:** 0
- **Full output:** [python-test-output.txt](python-test-output.txt)

### Warnings
56 `DeprecationWarning` from `dbus_next` about `typing.no_type_check_decorator` being deprecated in Python 3.15. Upstream library issue, not project-specific.

## GNOME Extension E2E Tests

- **Command:** `just gnome-ext-e2e-test`
- **Result:** ❌ Failed (exit code 127)
- **Error:** `sh: line 1: ./gnome-ext/e2e-test.sh: No such file or directory`
- **Full output:** [gnome-ext-e2e-test-output.txt](gnome-ext-e2e-test-output.txt)

### Root Cause
The `gnome-ext/e2e-test.sh` script exists on the `feat/api-key-command-substitution` branch (commit f868c5b) but was never merged to the current branch (`fix/gnome-ext-build`). The justfile recipe references a script that doesn't exist on this branch.

### Action Taken
Removed orphaned test recipes from justfile:
1. `gnome-ext-e2e-test` — referenced missing `gnome-ext/e2e-test.sh`
2. `test-e2e` / `test-all` — referenced empty `tests/e2e/` directory
