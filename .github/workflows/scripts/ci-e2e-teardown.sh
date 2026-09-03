#!/usr/bin/env bash
# Teardown phase: stop screencast, rescue artifacts, kill processes, exit with
# the suite's saved exit code. Workflow runs this with if: always().
set -euo pipefail
ASSETS="${CI_E2E_ASSETS:?}"
SCREENSHOT="${CI_E2E_SCREENSHOT:?}"
REPO_ROOT="${GITHUB_WORKSPACE:-$PWD}"

# --- Tear down -----------------------------------------------------------------------
mkdir -p "$REPO_ROOT/output"
if [ -f "$CI_E2E_ISOLATED/screencast-holder.pid" ]; then
  HPID="$(cat "$CI_E2E_ISOLATED/screencast-holder.pid")"
  kill -TERM "$HPID" 2>/dev/null || true
  for _ in $(seq 1 10); do kill -0 "$HPID" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$HPID" 2>/dev/null || true
fi
sleep 1
# recording%d.webm with a single session lands at recording0.webm
for f in "$CI_E2E_ISOLATED"/recording*.webm; do
  if [ -s "$f" ]; then
    cp "$f" "$REPO_ROOT/output/recording.webm" 2>/dev/null || true
    break
  fi
done
# Logs + prefs shot for debugging
cp "$CI_E2E_ISOLATED/service.log" "$REPO_ROOT/output/service.log" 2>/dev/null || true
cp "$CI_E2E_ISOLATED/shell.log" "$REPO_ROOT/output/shell.log" 2>/dev/null || true
cp "$CI_E2E_ISOLATED/screencast.log" "$REPO_ROOT/output/screencast.log" 2>/dev/null || true
# Suite output dir (results.json, prefs shots) — rescue whole dir
if [ -d "$ASSETS/e2e/output/ubuntu-bare" ]; then
  cp -r "$ASSETS/e2e/output/ubuntu-bare/." "$REPO_ROOT/output/" 2>/dev/null || true
fi
# Split the run screencast into per-cell clips using each cell's time window
if command -v ffmpeg >/dev/null 2>&1; then echo "ffmpeg: $(ffmpeg -version | head -1)"; else echo "ffmpeg: NOT FOUND"; fi
if command -v ffmpeg >/dev/null 2>&1 && [ -s "$REPO_ROOT/output/recording.webm" ]; then
  RUN_START="$SCREENCAST_START_EPOCH"
  for w in "$REPO_ROOT/output/cells"/*/window.txt; do
    [ -f "$w" ] || continue
    cellDir=$(dirname "$w")
    startIso=$(head -1 "$w")
    endIso=$(tail -1 "$w")
    startSec=$(python3 -c "import sys,datetime; t=datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')); print(t.timestamp())" "$startIso" 2>/dev/null) || continue
    endSec=$(python3 -c "import sys,datetime; t=datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')); print(t.timestamp())" "$endIso" 2>/dev/null) || continue
    recStart=$(python3 -c "import sys,datetime; print(datetime.datetime.fromtimestamp(int(sys.argv[1]), datetime.timezone.utc).timestamp())" "$RUN_START")
    ss=$(python3 -c "print(max(0, $startSec - $recStart))")
    to=$(python3 -c "print(max(0, $endSec - $recStart))")
    echo "clip: $cellDir ss=$ss to=$to"
    ffmpeg -y -ss "$ss" -to "$to" -i "$REPO_ROOT/output/recording.webm" -c copy "$cellDir/clip.webm" > "$cellDir/ffmpeg.log" 2>&1 || echo "WARN: ffmpeg failed for $cellDir"
  done
  rm -f "$REPO_ROOT/output/cells"/*/window.txt
fi

for pidfile in service shell wireplumber pipewire screencast-holder dbus; do
    [ -f "$CI_E2E_ISOLATED/$pidfile.pid" ] && kill "$(cat "$CI_E2E_ISOLATED/$pidfile.pid")" 2>/dev/null || true
done

TEST_EXIT=1
[ -f "$CI_E2E_ISOLATED/test-exit-code" ] && TEST_EXIT="$(cat "$CI_E2E_ISOLATED/test-exit-code")"
exit "$TEST_EXIT"
