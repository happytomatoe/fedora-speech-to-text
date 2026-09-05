container-watch:
    #!/usr/bin/env bash
    set -euo pipefail

    # Find running container
    POD=$(podman ps --filter ancestor=voice-to-text-e2e --format '{'{'.ID'}'}' | head -1)
    if [ -z "$POD" ]; then
      echo "No running voice-to-text-e2e container found."
      echo "Start one with: just e2e-full (in background) or podman run..."
      exit 1
    fi

    echo "Found container: $POD"

    # Install x11vnc as root (not gnomeshell user)
    echo "Installing x11vnc..."
    podman exec $POD dnf install -y --nogpgcheck x11vnc 2>/dev/null || true

    # Kill any existing VNC server
    podman exec --user gnomeshell $POD pkill x11vnc 2>/dev/null || true
    sleep 1

    # Start VNC server with -noshm to fix MIT-SHM error
    echo "Starting VNC server on port 5900..."
    podman exec --user gnomeshell -e DISPLAY=:100 -d $POD bash -c "nohup /usr/bin/x11vnc -display :100 -nopw -forever -shared -rfbport 5900 -noshm > /tmp/x11vnc.log 2>&1 &"
    sleep 3

    # Verify it started
    echo "Checking VNC server..."
    podman exec --user gnomeshell $POD cat /tmp/x11vnc.log 2>/dev/null | tail -5 || echo "No log yet"

    echo ""
    echo "========================================="
    echo "VNC server is running!"
    echo "Connect with any VNC client to: localhost:5900"
    echo ""
    echo "Suggested viewers:"
    echo "  - GNOME Connections"
    echo "  - Remmina"
    echo "  - TigerVNC Viewer"
    echo "  - macOS Screen Sharing (vnc://localhost:5900)"
    echo "========================================="
    echo ""
    echo "Press Ctrl+C to stop the VNC server"

    # Keep script running and cleanup on exit
    trap "podman exec --user gnomeshell $POD pkill x11vnc 2>/dev/null || true; echo 'VNC server stopped.'" EXIT
    # Block until user presses Ctrl+C (wait won't work since no background jobs in this shell)
    while true; do sleep 3600; done
qemu-e2e-test-ts:
    cd e2e && bun run e2e.ts
qemu-e2e-update-ts:
    cd e2e && bun run e2e.ts --update
e2e *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    cd e2e
    LOG="${E2E_LOG:-/tmp/fedora-speech-to-text-e2e-run.log}"
    : > "$LOG"
    bun run e2e.ts --save-snapshot {{ ARGS }} 2>&1 | tee "$LOG"
    exit ${PIPESTATUS[0]}
e2e-parallel *ARGS:
    cd e2e && bun run e2e.ts --parallel {{ ARGS }}
e2e-prefs:
    cd e2e && bun run e2e.ts --test-prefs
e2e-all *ARGS:
    cd e2e && bun run e2e.ts --parallel 2 {{ ARGS }}
e2e-snapshot *ARGS:
    cd e2e && bun run e2e.ts --save-snapshot {{ ARGS }}
e2e-no-snapshot:
    cd e2e && bun run e2e.ts --no-snapshot
e2e-update:
    cd e2e && bun run e2e.ts --update

# Unified E2E suite — one command per environment:
#   just e2e-fedora-local   (default; snapshot mode, fast ~40s after first run)
#   just e2e-ubuntu-local   (fresh pinned resolute VM)
#   just e2e-ubuntu-ci      (same bits as ubuntu-local; CI now runs the
#                            bare-runner headless harness instead — see
#                            docs/CI-E2E-STATUS.md)
# Output is always tee'd to /tmp/fedora-speech-to-text-e2e-run.log — tail it to
# watch progress: tail -f /tmp/fedora-speech-to-text-e2e-run.log
# Override with args: just e2e-fedora-local --update
_e2e-run E2E_ENV *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    cd e2e
    LOG="${E2E_LOG:-/tmp/fedora-speech-to-text-e2e-run.log}"
    : > "$LOG"
    if [[ "{{ E2E_ENV }}" == "fedora-local" ]]; then
      bun run e2e.ts --save-snapshot {{ ARGS }} 2>&1 | tee "$LOG"
      exit ${PIPESTATUS[0]}
    else
      bun run e2e.ts --env "{{ E2E_ENV }}" {{ ARGS }} 2>&1 | tee "$LOG"
      exit ${PIPESTATUS[0]}
    fi

e2e-fedora-local *ARGS:
    just _e2e-run fedora-local {{ ARGS }}

e2e-ubuntu-local *ARGS:
    just _e2e-run ubuntu-local {{ ARGS }}

e2e-ubuntu-ci *ARGS:
    just _e2e-run ubuntu-ci {{ ARGS }}

# First-time setup for the Ubuntu env of the unified suite: pinned resolute
# cloud image + golden customization + ssh key (same URL/recipe as CI).
e2e-setup-ubuntu:
    ./e2e/setup-ubuntu-vm.sh

# @category e2e-ubuntu-ci (LEGACY - CI runs the bare-runner headless harness;
# this VM-based env is kept for local reproduction of CI failures)
ubuntu-ci-e2e *args='':
    just e2e ubuntu-ci {{ args }}

# @category e2e-ubuntu-ci (LEGACY)
ubuntu-ci-e2e-setup:
    just e2e-setup-ubuntu
