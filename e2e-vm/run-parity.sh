#!/usr/bin/env bash
# Run the CI headless E2E harness inside the Ubuntu 26.04 VM, locally.
# Parakeet must run on the HOST (just e2e-vm-parakeet); the guest reaches it
# via the QEMU user-network gateway 10.0.2.2:5092.
#
# What this does:
#   1. Installs bun + uv into the VM (idempotent)
#   2. Rsyncs the repo into the VM (excluding .git, images, node_modules)
#   3. Starts PulseAudio with null devices (CI does the same)
#   4. Runs .github/workflows/scripts/ci-e2e-headless.sh UNCHANGED
#   5. Copies screenshot/artifacts back to ./e2e-vm/output/
set -euo pipefail

VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$VM_DIR/.." && pwd)"
OUT="$VM_DIR/output"
SSH_CMD="ssh -p 2222 -i $VM_DIR/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null testuser@localhost"
SSH="$SSH_CMD"
mkdir -p "$OUT/common"

# 1. bun + uv in the VM (idempotent)
$SSH 'command -v bun >/dev/null || (curl -fsSL https://bun.sh/install | bash); command -v uv >/dev/null || (curl -LsSf https://astral.sh/uv/install.sh | sh)' 2>/dev/null

# 2. Sync repo
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude "*.qcow2" \
  --exclude e2e-vm/output --exclude e2e/output-qemu \
  -e "ssh -p 2222 -i $VM_DIR/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
  "$REPO_ROOT/" "testuser@localhost:~/repo/"

# 3. PulseAudio with virtual devices inside the VM (CI parity) + Parakeet env.
#    The CI harness expects Parakeet at localhost:5092; the VM's localhost is
#    not the host. The harness has no host override, so we port-forward with
#    a tiny relay: socat inside the VM, 10.0.2.2:5092 -> 127.0.0.1:5092.
$SSH 'command -v socat >/dev/null || sudo apt-get install -y --no-install-recommends socat'
$SSH 'pkill -f "socat.*TCP-LISTEN:5092" 2>/dev/null; sleep 0.5; nohup socat TCP-LISTEN:5092,fork,reuseaddr TCP:10.0.2.2:5092 > /tmp/socat.log 2>&1 & disown; sleep 1; curl -sf http://localhost:5092/health > /dev/null && echo "Parakeet reachable in VM"' || $SSH 'nohup socat TCP-LISTEN:5092,fork,reuseaddr TCP:10.0.2.2:5092 > /tmp/socat.log 2>&1 < /dev/null & sleep 1; curl -sf http://localhost:5092/health'

# 4. PulseAudio null devices (needed by PortAudio in the service)
$SSH 'pactl info >/dev/null 2>&1 || (pulseaudio -D --exit-idle-time=-1 --disallow-exit=true --load="module-null-sink sink_name=virtual_sink" --load="module-null-source source_name=virtual_mic"; for i in $(seq 1 20); do pactl info >/dev/null 2>&1 && break; sleep 1; done); pactl list short sinks | head -2'

# 4b. Stub docker/podman: the CI harness starts a Parakeet container itself;
# in the VM we relay 10.0.2.2:5092 (host Parakeet) instead. A fake `docker`
# shim satisfies the harness's runtime check and no-ops its container steps.
$SSH 'command -v docker >/dev/null || printf "#!/bin/sh\nexit 0\n" | sudo tee /usr/local/bin/docker >/dev/null && sudo chmod +x /usr/local/bin/docker'

# 4c-b. Reclaim space: each harness run leaves a ~286MB isolated HOME in /tmp;
# the 2GB tmpfs fills after ~5 runs (disk-quota failures mid-run).
$SSH 'rm -rf /tmp/tmp.??????????/ 2>/dev/null; true'

# 4c. Screenshot naming mirrors e2e/ layout: output/common/screenshot-<NN>-<label>.png
#     All shots are taken inside the harness via org.gnome.Shell.Screenshot
#     (the VM runs with -display none, so QEMU monitor screendumps are blank).

# 1. (01-desktop before-shot is taken inside the harness via
#     org.gnome.Shell.Screenshot — see step 6. -display none makes monitor
#     screendumps blank.)

# 5. Run the CI harness unchanged — now split into stage/boot/run/teardown
#    steps (mirrors ubuntu-ci-e2e.yml). GITHUB_WORKSPACE required: the
#    scripts' dirname fallback breaks when invoked via repo-relative path
#    from the VM's home. GITHUB_ENV is emulated with a plain file the steps
#    append to (stage.sh exports CI_E2E_* vars that boot/run/teardown read).
$SSH 'cd ~/repo && export PATH=$HOME/.local/bin:$HOME/.bun/bin:$PATH && \
    export GITHUB_WORKSPACE=$HOME/repo GITHUB_ENV=$HOME/parity-github-env && \
    : > $GITHUB_ENV && \
    bash .github/workflows/scripts/ci-e2e-stage.sh 2>&1 && \
    set -a; source $GITHUB_ENV; set +a && \
    bash .github/workflows/scripts/ci-e2e-boot.sh 2>&1 && \
    bash .github/workflows/scripts/ci-e2e-run.sh 2>&1; \
    TEST_EXIT=$?; \
    bash .github/workflows/scripts/ci-e2e-teardown.sh 2>&1 || true; \
    echo PARITY_TEST_EXIT=$TEST_EXIT' | tee "$OUT/harness.log"
TEST_EXIT=$(grep -oP 'PARITY_TEST_EXIT=\K[0-9]+' "$OUT/harness.log" | tail -1)
TEST_EXIT=${TEST_EXIT:-1}

# 6. Pull harness-side screenshots (in-shell org.gnome.Shell.Screenshot —
#    the VM runs with -display none, so QEMU monitor screendumps are blank).
#    before = 01-desktop, during = 04-recording-started, after = 05-transcription-received
# Suite-side shots (prefs lifecycle, cells) rescued by teardown into ~/repo/output
rsync -az -e "ssh -p 2222 -i $VM_DIR/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
  "testuser@localhost:~/repo/output/" "$OUT/suite-output/" 2>/dev/null \
  || echo "WARN: no suite output"
for pair in "before 01-desktop" "during 04-recording-started" "after 05-transcription-received"; do
  set -- $pair
  scp -q -P 2222 -i "$VM_DIR/id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "testuser@localhost:~/parity-screenshot-$1.png" "$OUT/common/screenshot-$2.png" 2>/dev/null \
    || echo "WARN: no $1 screenshot"
done

# 6b. Pull the screencast recording (webm, covers record→transcribe→type)
scp -q -P 2222 -i "$VM_DIR/id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  "testuser@localhost:~/recording.webm" "$OUT/recording.webm" 2>/dev/null \
  || echo "WARN: no recording"

echo "exit=$TEST_EXIT"
exit "$TEST_EXIT"
