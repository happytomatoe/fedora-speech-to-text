#!/usr/bin/env bash
# One-shot SonarQube scan using Podman.
# Starts a temporary SonarQube + scanner, exports results, tears down.
#
# Usage:
#   scripts/sonar-scan.sh                  # scan and tear down
#   scripts/sonar-scan.sh --keep-server    # scan but keep SonarQube running
#   scripts/sonar-scan.sh --tear-down      # stop a previously kept server
#   scripts/sonar-scan.sh --fail-on-gate   # exit non-zero if quality gate fails (for CI)
#   scripts/sonar-scan.sh --reports-dir /tmp/reports  # custom output dir
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────
SONAR_VERSION="${SONAR_VERSION:-26.4.0.121862-community}"
SCANNER_VERSION="${SCANNER_VERSION:-12.1}"
CONTAINER_NAME="${SONAR_CONTAINER_NAME:-sonarqube-oneshot}"
SCANNER_CONTAINER="${SONAR_SCANNER_CONTAINER:-sonar-scanner-oneshot}"
SONAR_PORT="${SONAR_PORT:-9000}"
SONAR_USER="${SONAR_USER:-admin}"
SONAR_PASS="${SONAR_PASS:-Sonarless123!}"
PROJECT_KEY="${SONAR_PROJECT_KEY:-voice-to-text}"
REPORTS_DIR="${SONAR_REPORTS_DIR:-sonar-reports}"

# ── Parse args ─────────────────────────────────────────────────────────
KEEP_SERVER=false
TEAR_DOWN=false
FAIL_ON_GATE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep-server)  KEEP_SERVER=true; shift ;;
        --tear-down)    TEAR_DOWN=true; shift ;;
        --fail-on-gate) FAIL_ON_GATE=true; shift ;;
        --reports-dir)  REPORTS_DIR="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: $0 [--keep-server] [--tear-down] [--fail-on-gate] [--reports-dir DIR]"
            echo ""
            echo "  --keep-server   Keep SonarQube running after scan (for web UI)"
            echo "  --tear-down     Stop a previously kept SonarQube server"
            echo "  --fail-on-gate  Exit non-zero if quality gate fails (for CI)"
            echo "  --reports-dir   Output directory for reports (default: sonar-reports/)"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ── Helpers ────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
    if [[ "$TEAR_DOWN" == true ]] || [[ "$KEEP_SERVER" == false ]]; then
        log "Cleaning up containers..."
        podman rm -f "$CONTAINER_NAME" 2>/dev/null || true
        podman rm -f "$SCANNER_CONTAINER" 2>/dev/null || true
        podman network rm sonar-net 2>/dev/null || true
        ok "Cleanup done"
    fi
}

wait_for_sonar() {
    local url="http://localhost:${SONAR_PORT}/api/system/status"
    log "Waiting for SonarQube to start (this takes ~60-90s)..."
    for i in $(seq 1 180); do
        local status
        status=$(curl -sf "$url" 2>/dev/null | podman exec -i "$CONTAINER_NAME" cat 2>/dev/null || true)
        # Try without container exec — direct curl from host
        status=$(curl -sf "$url" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || true)
        if [[ "$status" == "UP" ]]; then
            ok "SonarQube is ready (took ${i}s)"
            return 0
        fi
        printf '.'
        sleep 1
    done
    echo ""
    fail "SonarQube did not start within 180 seconds. Check: podman logs $CONTAINER_NAME"
}

# ── Tear-down mode ─────────────────────────────────────────────────────
if [[ "$TEAR_DOWN" == true ]]; then
    log "Tearing down SonarQube..."
    podman rm -f "$CONTAINER_NAME" 2>/dev/null || true
    podman rm -f "$SCANNER_CONTAINER" 2>/dev/null || true
    podman network rm sonar-net 2>/dev/null || true
    ok "SonarQube stopped and removed"
    exit 0
fi

# ── Check prerequisites ────────────────────────────────────────────────
command -v podman >/dev/null 2>&1 || fail "podman is not installed"
command -v curl   >/dev/null 2>&1 || fail "curl is not installed"
command -v jq     >/dev/null 2>&1 || fail "jq is not installed (install: sudo dnf install jq)"

# ── Check/set vm.max_map_count (Elasticsearch needs >= 262144) ─────────
# Try sysctl first; if it fails (no sudo), fall back to disabling mmap in ES
USE_MMAP_FALLBACK=false
CURRENT_MMAP=$(cat /proc/sys/vm/max_map_count 2>/dev/null || echo "0")
if [[ "$CURRENT_MMAP" -lt 262144 ]]; then
    log "vm.max_map_count=$CURRENT_MMAP (needs >= 262144)..."
    if sudo sysctl -w vm.max_map_count=262144 >/dev/null 2>&1; then
        ok "Set vm.max_map_count=262144"
    else
        log "Cannot set sysctl (no sudo). Disabling mmap in Elasticsearch instead."
        USE_MMAP_FALLBACK=true
    fi
fi

# ── Ensure cleanup on exit ─────────────────────────────────────────────
trap cleanup EXIT

# ── Pull images ────────────────────────────────────────────────────────
log "Pulling SonarQube ${SONAR_VERSION}..."
podman pull -q "sonarqube:${SONAR_VERSION}" 2>/dev/null || \
    podman pull -q "docker.io/library/sonarqube:${SONAR_VERSION}" 2>/dev/null || \
    fail "Failed to pull sonarqube image"

log "Pulling SonarScanner ${SCANNER_VERSION}..."
podman pull -q "sonarsource/sonar-scanner-cli:${SCANNER_VERSION}" 2>/dev/null || \
    fail "Failed to pull sonar-scanner-cli image"

# ── Create network ─────────────────────────────────────────────────────
podman network rm sonar-net 2>/dev/null || true
podman network create sonar-net >/dev/null 2>&1

# ── Stop any existing container ────────────────────────────────────────
podman rm -f "$CONTAINER_NAME" 2>/dev/null || true

# ── Start SonarQube ────────────────────────────────────────────────────
log "Starting SonarQube container..."
MMAP_OPTS=""
if [[ "$USE_MMAP_FALLBACK" == true ]]; then
    MMAP_OPTS="-e SONAR_SEARCH_JAVAADDITIONALOPTS=-Dnode.store.allow_mmap=false"
fi
podman run -d \
    --name "$CONTAINER_NAME" \
    --network sonar-net \
    -p "${SONAR_PORT}:9000" \
    -e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true \
    $MMAP_OPTS \
    "sonarqube:${SONAR_VERSION}" >/dev/null

# ── Wait for ready ─────────────────────────────────────────────────────
wait_for_sonar

# ── Change admin password (required on first run) ────────────────────
log "Setting up admin credentials..."
curl -sf -u "admin:admin" -X POST \
    "http://localhost:${SONAR_PORT}/api/users/change_password" \
    -d "login=admin&previousPassword=admin&password=${SONAR_PASS}" \
    >/dev/null 2>&1 || true  # ignore if already changed

# ── Create project via API ─────────────────────────────────────────────
log "Creating project '${PROJECT_KEY}'..."
curl -sf -u "${SONAR_USER}:${SONAR_PASS}" -X POST \
    "http://localhost:${SONAR_PORT}/api/projects/create?name=${PROJECT_KEY}&project=${PROJECT_KEY}" \
    >/dev/null 2>&1 || true  # ignore if already exists

# ── Generate token ─────────────────────────────────────────────────────
log "Generating analysis token..."
TOKEN_RESPONSE=$(curl -sf -u "${SONAR_USER}:${SONAR_PASS}" -X POST \
    "http://localhost:${SONAR_PORT}/api/user_tokens/generate?name=scan-$(date +%s)")
SONAR_TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
if [[ -z "$SONAR_TOKEN" ]]; then
    fail "Failed to generate token. Response: $TOKEN_RESPONSE"
fi
ok "Token generated"

# ── Run scanner ────────────────────────────────────────────────────────
log "Running SonarScanner..."
PROJECT_DIR="$(pwd)"

podman run --rm \
    --name "$SCANNER_CONTAINER" \
    --network sonar-net \
    -e SONAR_HOST_URL="http://${CONTAINER_NAME}:9000" \
    -e SONAR_TOKEN="${SONAR_TOKEN}" \
    -e SONAR_SCANNER_OPTS="-Dsonar.projectKey=${PROJECT_KEY} -Dsonar.sources=src -Dsonar.tests=tests" \
    -v "${PROJECT_DIR}:/usr/src:Z" \
    "sonarsource/sonar-scanner-cli:${SCANNER_VERSION}"
SCANNER_EXIT=$?

if [[ $SCANNER_EXIT -ne 0 ]]; then
    fail "SonarScanner failed with exit code $SCANNER_EXIT"
fi

# ── Wait for analysis to complete ──────────────────────────────────────
log "Waiting for analysis to finish..."
for i in $(seq 1 120); do
    GATE_STATUS=$(curl -sf -u "${SONAR_USER}:${SONAR_PASS}" \
        "http://localhost:${SONAR_PORT}/api/qualitygates/project_status?projectKey=${PROJECT_KEY}" | \
        python3 -c "import sys,json; print(json.load(sys.stdin)['projectStatus']['status'])" 2>/dev/null || echo "NONE")
    if [[ "$GATE_STATUS" != "NONE" ]]; then
        break
    fi
    printf '.'
    sleep 1
done
echo ""
# Give SonarQube a moment to finish indexing after quality gate passes
sleep 5

# ── Export results ─────────────────────────────────────────────────────
mkdir -p "$REPORTS_DIR"

log "Exporting results to ${REPORTS_DIR}/..."

# Metrics JSON
curl -sf -u "${SONAR_USER}:${SONAR_PASS}" \
    "http://localhost:${SONAR_PORT}/api/measures/component?component=${PROJECT_KEY}&metricKeys=bugs,vulnerabilities,code_smells,quality_gate_details,violations,duplicated_lines_density,ncloc,coverage,reliability_rating,security_rating,security_review_rating,sqale_rating,security_hotspots,open_issues" \
    | python3 -m json.tool > "${REPORTS_DIR}/metrics.json" 2>/dev/null || true

# Issues JSON
curl -sf -u "${SONAR_USER}:${SONAR_PASS}" \
    "http://localhost:${SONAR_PORT}/api/issues/search?componentKeys=${PROJECT_KEY}&ps=500&resolved=false" \
    | python3 -m json.tool > "${REPORTS_DIR}/issues.json" 2>/dev/null || true

# Quality gate status
curl -sf -u "${SONAR_USER}:${SONAR_PASS}" \
    "http://localhost:${SONAR_PORT}/api/qualitygates/project_status?projectKey=${PROJECT_KEY}" \
    | python3 -m json.tool > "${REPORTS_DIR}/quality-gate.json" 2>/dev/null || true

# ── Fetch rule details and source snippets for HTML report ─────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log "Fetching rule details and source snippets..."
if [[ -f "${SCRIPT_DIR}/sonar-fetch-details.py" ]]; then
    python3 "${SCRIPT_DIR}/sonar-fetch-details.py" "${REPORTS_DIR}" \
        "http://localhost:${SONAR_PORT}" "${SONAR_USER}" "${SONAR_PASS}" 2>/dev/null || true
fi

# ── Generate HTML report ──────────────────────────────────────────────
log "Generating HTML report..."
if [[ -f "${SCRIPT_DIR}/sonar-report-html.py" ]]; then
    python3 "${SCRIPT_DIR}/sonar-report-html.py" "${REPORTS_DIR}" 2>/dev/null || true
fi

# ── Summary ────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ "$GATE_STATUS" == "OK" ]]; then
    ok "Scan complete! Quality gate PASSED"
else
    fail "Scan complete! Quality gate FAILED (${GATE_STATUS})"
fi
echo ""
echo "  Quality Gate:  ${GATE_STATUS}"
echo "  Reports:       ${REPORTS_DIR}/"
echo "    report.html        ← open this in a browser"
echo "    metrics.json       — code metrics"
echo "    issues.json        — all open issues"
echo "    quality-gate.json  — pass/fail status"
echo ""

if [[ "$KEEP_SERVER" == true ]]; then
    echo "  SonarQube UI:  http://localhost:${SONAR_PORT}"
    echo "  Credentials:   ${SONAR_USER} / ${SONAR_PASS}"
    echo ""
    echo "  To stop later:  $0 --tear-down"
else
    echo "  Server stopped automatically (use --keep-server to keep it)"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Open HTML report ──────────────────────────────────────────────────
REPORT_HTML="${REPORTS_DIR}/report.html"
if [[ -f "$REPORT_HTML" ]]; then
    log "Opening report in browser..."
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$REPORT_HTML"
    elif command -v open >/dev/null 2>&1; then
        open "$REPORT_HTML"
    else
        echo "  Open manually: $REPORT_HTML"
    fi
fi

# ── Exit with non-zero if quality gate fails ──────────────────────────
if [[ "$FAIL_ON_GATE" == true ]] && [[ "$GATE_STATUS" != "OK" ]]; then
    exit 1
fi
