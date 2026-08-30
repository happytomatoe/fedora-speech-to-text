#!/usr/bin/env bash
# pick-fedora-mirror.sh
#
# Two-stage mirror picker for a Fedora Cloud image:
#   Stage 1 (triage):  fire a cheap HEAD request at every candidate, in parallel.
#                       Anything that fails, 404s, or is slow gets crossed out.
#   Stage 2 (speed):   take the survivors and do a real partial-download
#                       speed test on them ONE AT A TIME (parallel downloads
#                       would just compete for your own bandwidth and lie to you).
#   Result:            fastest mirror wins, gets written to a sidecar cache file
#                       so re-runs skip the whole race.
#
# Usage:
#   ./pick-fedora-mirror.sh [RELEASE] [ARCH]
#   ./pick-fedora-mirror.sh 44 x86_64
#
# Env overrides:
#   PROBE_BYTES=20000000   # bytes to pull in the stage-2 speed test (default 20MB)
#   MAX_LATENCY_MS=1500    # stage-1 cutoff; anything slower than this is dropped
#   KEEP_TOP_N=4           # how many stage-1 survivors go on to stage-2
#   CACHE_TTL_HOURS=24     # re-race if the cached winner is older than this

set -euo pipefail

RELEASE="${1:-44}"
ARCH="${2:-x86_64}"
PROBE_BYTES="${PROBE_BYTES:-20000000}"
MAX_LATENCY_MS="${MAX_LATENCY_MS:-1500}"
KEEP_TOP_N="${KEEP_TOP_N:-4}"
CACHE_TTL_HOURS="${CACHE_TTL_HOURS:-24}"

CACHE_FILE="${TMPDIR:-/tmp}/fedora-mirror-cache-${RELEASE}-${ARCH}"
IMG_PATH="linux/releases/${RELEASE}/Cloud/${ARCH}/images"
IMG_FILE="Fedora-Cloud-Base-Generic-${RELEASE}-1.1.${ARCH}.qcow2"  # adjust per release if needed

log()  { echo "[$(date +%H:%M:%S)] $*" >&2; }

# ---------------------------------------------------------------------------
# 0. Cache check — if we raced recently, just reuse the winner.
# ---------------------------------------------------------------------------
if [[ -f "$CACHE_FILE" ]]; then
    age_hours=$(( ( $(date +%s) - $(stat -c %Y "$CACHE_FILE" 2>/dev/null || stat -f %m "$CACHE_FILE") ) / 3600 ))
    if (( age_hours < CACHE_TTL_HOURS )); then
        log "Using cached winner (age ${age_hours}h): $(cat "$CACHE_FILE")"
        cat "$CACHE_FILE"
        exit 0
    fi
    log "Cache is ${age_hours}h old (TTL ${CACHE_TTL_HOURS}h) — re-racing."
fi

# ---------------------------------------------------------------------------
# 1. Candidate list.
#    Always include Fedora's own CDN-backed fallbacks (dl.fedoraproject.org
#    and the CloudFront distribution baked into every official mirrorlist) —
#    they're global and don't depend on finding a lucky regional volunteer.
#    Add/remove volunteer mirrors here as you discover them.
# ---------------------------------------------------------------------------
CANDIDATES=(
    "https://dl.fedoraproject.org/pub/fedora/${IMG_PATH}"
    "https://d2lzkl7pfhq30w.cloudfront.net/pub/fedora/${IMG_PATH}"
    "https://mirror.math.princeton.edu/pub/fedora-archive/fedora/${IMG_PATH}"
    "https://ftp-stud.hs-esslingen.de/pub/Mirrors/archive.fedoraproject.org/fedora/${IMG_PATH}"
    "https://mirror.fcix.net/fedora-archive/fedora/${IMG_PATH}"
    "https://pubmirror1.math.uh.edu/fedora-buffet/archive/fedora/${IMG_PATH}"
    "https://mirror.aarnet.edu.au/pub/fedora/${IMG_PATH}"
    "https://ftp.iij.ad.jp/pub/linux/Fedora/fedora/${IMG_PATH}"
)

# ---------------------------------------------------------------------------
# Stage 1: latency triage.
# HEAD-only, short timeout, run all candidates in parallel with xargs -P.
# Output: "latency_ms<TAB>url", one line per reachable candidate.
# ---------------------------------------------------------------------------
probe_latency() {
    local base="$1"
    local url="${base}/${IMG_FILE}"
    local t
    t=$(curl -o /dev/null -s -I \
            --max-time 4 \
            -w '%{time_total}' \
            "$url" 2>/dev/null) || { echo -e "999999\t${base}"; return; }
    # curl gave a time even on 404/error, so check status separately
    local code
    code=$(curl -o /dev/null -s -I --max-time 4 -w '%{http_code}' "$url" 2>/dev/null) || code=000
    if [[ "$code" != "200" && "$code" != "206" ]]; then
        echo -e "999999\t${base}"
        return
    fi
    local ms
    ms=$(awk -v t="$t" 'BEGIN{printf "%d", t*1000}')
    echo -e "${ms}\t${base}"
}
export -f probe_latency
export IMG_FILE

log "Stage 1: latency triage across ${#CANDIDATES[@]} candidates..."
STAGE1_RESULTS=$(printf '%s\n' "${CANDIDATES[@]}" \
    | xargs -P "${#CANDIDATES[@]}" -I{} bash -c 'probe_latency "$@"' _ {})

# Sort by latency, drop anything unreachable (999999) or over the cutoff,
# keep the top N to move on to the real speed test.
SURVIVORS=$(echo "$STAGE1_RESULTS" \
    | sort -n \
    | awk -v cutoff="$MAX_LATENCY_MS" -F'\t' '$1 < cutoff' \
    | head -n "$KEEP_TOP_N")

log "Stage 1 results (ms, sorted):"
echo "$STAGE1_RESULTS" | sort -n | while IFS=$'\t' read -r ms url; do
    if [[ "$ms" == "999999" ]]; then
        log "  DEAD      ${url}"
    else
        log "  ${ms}ms$( [[ -z "$(echo "$SURVIVORS" | grep -F "$url")" ]] && echo " (crossed out, over cutoff)" ) ${url}"
    fi
done

if [[ -z "$SURVIVORS" ]]; then
    log "No candidate survived stage 1 (all dead or over ${MAX_LATENCY_MS}ms). Raise MAX_LATENCY_MS or check your network."
    exit 1
fi

log "Stage 1 survivors advancing to speed test:"
echo "$SURVIVORS" | while IFS=$'\t' read -r ms url; do log "  ${url} (${ms}ms)"; done

# ---------------------------------------------------------------------------
# Stage 2: real speed test, one mirror at a time.
# Pulls a PROBE_BYTES-sized range so slow-start / TLS handshake overhead
# doesn't dominate the measurement the way a HEAD-only ping would.
# ---------------------------------------------------------------------------
probe_speed() {
    local base="$1"
    local url="${base}/${IMG_FILE}"
    local speed
    speed=$(curl -o /dev/null -s \
                --max-time 20 \
                -r "0-$((PROBE_BYTES - 1))" \
                -w '%{speed_download}' \
                "$url" 2>/dev/null) || { echo "0"; return; }
    echo "$speed"
}

log "Stage 2: speed-testing survivors sequentially (${PROBE_BYTES} bytes each)..."
BEST_URL=""
BEST_SPEED=0
while IFS=$'\t' read -r ms url; do
    speed=$(probe_speed "$url")
    mbps=$(awk -v s="$speed" 'BEGIN{printf "%.1f", s/1000000}')
    log "  ${url} -> ${mbps} MB/s"
    if awk -v a="$speed" -v b="$BEST_SPEED" 'BEGIN{exit !(a>b)}'; then
        BEST_SPEED="$speed"
        BEST_URL="$url"
    fi
done <<< "$SURVIVORS"

if [[ -z "$BEST_URL" ]]; then
    log "All stage-2 speed tests failed. Falling back to fastest stage-1 latency result."
    BEST_URL=$(echo "$SURVIVORS" | head -n1 | cut -f2)
fi

BEST_MBPS=$(awk -v s="$BEST_SPEED" 'BEGIN{printf "%.1f", s/1000000}')
log "Winner: ${BEST_URL} (${BEST_MBPS} MB/s)"

echo "$BEST_URL" > "$CACHE_FILE"
echo "$BEST_URL"
