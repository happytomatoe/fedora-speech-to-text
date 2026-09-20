lint:
    uv run ruff check .
    uv run ruff format --check .
    uv run pyright
    just gnome-ext-lint
    just check-output-methods-sync
    echo "All lint checks passed!"

# @category lint
# Check output methods are in sync across engine, prefs, and schema
check-output-methods-sync:
    ./scripts/check-output-methods-sync.sh

# @category lint
# Auto-fix lint issues
lint-fix:
    uv run ruff check --fix .
    uv run ruff format .
    echo "Lint fixes applied."
# @category test

# @category review
# Run EGO (extensions.gnome.org) compliance checks on GNOME extension
# Determines review readiness, identifies blocking issues, and provides
# specific fix recommendations for extension.gnome.org submission.
ego-lint:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== GNOME Extension EGO Compliance Check ==="
    echo "Running comprehensive compliance checks for extensions.gnome.org"
    echo ""
    echo "This runs ego-lint against the gnome-ext/ directory to:"
    echo "  ✓ Validate metadata.json format and required fields"
    echo "  ✓ Check JS syntax and TypeScript compliance"  
    echo "  ✓ Verify lifecycle symmetry (enable/disable)"
    echo "  ✓ Detect deprecated module imports"
    echo "  ✓ Identify AI slop patterns"
    echo "  ✓ Check security issues (subprocess, eval, etc.)"
    echo ""
    echo "Check results provide specific fix suggestions for each issue."
    echo ""
    echo "⚠️  Warning: Extensions with FAIL issues will likely be REJECTED."
    echo ""
    echo "Running ego-lint on gnome-ext/..."
    ./scripts/ego-lint --show=fail,warn gnome-ext/
    echo ""
    echo "=== EGO Review Complete ==="

# @category metrics
# Run all code-quality metric tools (measurement only, reports in metrics-report/)
