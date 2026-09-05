# @category e2e-qemu
install-spice-client:
    flatpak install -y flathub org.virt_manager.virt-viewer
    # Block GNOME Shell portal to suppress "Allow inhibiting shortcuts" dialog
    # This prevents the app from requesting shortcut inhibition via the portal
    flatpak override --user --no-talk-name=org.gnome.Shell org.virt_manager.virt-viewer
# @category e2e-qemu
qemu-e2e-kill:
    #!/usr/bin/env bash
    set -euo pipefail
    PID_FILE="e2e/qemu-images/qemu.pid"
    if [[ -f "${PID_FILE}" ]]; then
        PID=$(cat "${PID_FILE}")
        if kill -0 "${PID}" 2>/dev/null; then
            echo "Killing QEMU (PID ${PID})..."
            kill "${PID}" 2>/dev/null || true
            sleep 2
            kill -9 "${PID}" 2>/dev/null || true
        else
            echo "QEMU PID ${PID} not running"
        fi
        rm -f "${PID_FILE}"
    fi
    # Also kill any stray QEMU processes
    # Kill only QEMU processes using THIS repo's overlay (not unrelated VMs):
    # match on the repo-rooted absolute overlay path.
    pkill -9 -f "$(pwd)/e2e/qemu-images/overlay.qcow2" 2>/dev/null || true
    rm -f e2e/qemu-images/overlay.qcow2 e2e/qemu-images/qemu-monitor.sock
    echo "Done"
# @category e2e-qemu
qemu-e2e-vm port='5930':
    #!/usr/bin/env bash
    set -euo pipefail
    VM_DIR="e2e/qemu-images"
    VM_DIR_ABS="$(pwd)/${VM_DIR}"

    # Kill any existing QEMU for this VM (use specific path to avoid killing unrelated VMs)
    if [ -f "${VM_DIR_ABS}/qemu.pid" ]; then
        QEMU_PID=$(cat "${VM_DIR_ABS}/qemu.pid")
        # Verify the PID is a QEMU process before killing
        if ps -p "$QEMU_PID" -o comm= 2>/dev/null | grep -q qemu; then
            kill -9 "$QEMU_PID" 2>/dev/null || true
        fi
        rm -f "${VM_DIR_ABS}/qemu.pid"
    fi
    sleep 1

    # Create fresh overlay
    rm -f "${VM_DIR_ABS}/overlay.qcow2"
    qemu-img create -f qcow2 -b "${VM_DIR_ABS}/base.qcow2" -F qcow2 "${VM_DIR_ABS}/overlay.qcow2"

    # Start QEMU with SPICE
    cd "${VM_DIR_ABS}"
    qemu-system-x86_64 \
        -enable-kvm \
        -cpu host \
        -m 4096 \
        -smp 2 \
        -drive file=overlay.qcow2,format=qcow2,if=virtio \
        -device virtio-vga \
        -display vnc=:1 \
        -spice port={{ port }},disable-ticketing=on \
        -monitor unix:qemu-monitor.sock,server,nowait \
        -serial file:serial.log \
        -netdev user,id=net0,hostfwd=tcp::2222-:22 \
        -device virtio-net-pci,netdev=net0 \
        -cdrom cloud-init.iso \
        -no-reboot &
    QEMU_PID=$!
    echo $QEMU_PID > qemu.pid

    echo "QEMU started (PID: ${QEMU_PID})"
    echo ""
    echo "Waiting for SSH..."
    ssh_ready=false
    for i in $(seq 1 30); do
        if ssh -i id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 -p 2222 testuser@localhost echo ok 2>/dev/null; then
            echo "SSH ready (${i}s)"
            ssh_ready=true
            break
        fi
        echo -n "."
        sleep 2
    done

    if [ "$ssh_ready" = false ]; then
        echo ""
        echo "❌ ERROR: SSH connection failed after 60 seconds"
        kill "${QEMU_PID}" 2>/dev/null || true
        rm -f "${VM_DIR_ABS}/qemu.pid"
        exit 1
    fi

    echo ""
    echo "=== VM is ready ==="
    echo "SPICE: remote-viewer spice://localhost:5930"
    echo "  or:  just e2e-test-view"
    echo "SSH:   ssh -i ${VM_DIR}/id_ed25519 -p 2222 testuser@localhost"
    echo "Kill:  just qemu-e2e-kill"
    echo ""
    echo "Press Ctrl+C to stop the VM"

    # Wait for user interrupt
    trap "echo ''; echo 'Shutting down VM...'; kill ${QEMU_PID} 2>/dev/null || true; exit 0" INT TERM
    wait ${QEMU_PID} 2>/dev/null || true
e2e-test-view spice_port='' ssh_port='':
    #!/usr/bin/env bash
    set -euo pipefail

    # Auto-detect ports if not specified
    if [ -z "{{ spice_port }}" ]; then
        # Find SPICE port from QEMU processes (look for -spice port=XXXX)
        SPICE_PORT=$(ps aux | grep -oP 'qemu.*-spice port=\K\d+' | head -1 || true)
        if [ -z "$SPICE_PORT" ]; then
            # Fallback: find any listening port in SPICE range (5930-5999)
            SPICE_PORT=$(ss -tlnp 2>/dev/null | grep -oP ':\K(59[3-9]\d)\b' | head -1 || true)
        fi
        if [ -z "$SPICE_PORT" ]; then
            echo "ERROR: Could not auto-detect SPICE port"
            echo "Specify manually: just e2e-test-view <spice_port> <ssh_port>"
            exit 1
        fi
    else
        SPICE_PORT="{{ spice_port }}"
    fi

    if [ -z "{{ ssh_port }}" ]; then
        # Find SSH port from QEMU processes (look for hostfwd=tcp::XXXX-:22)
        SSH_PORT=$(ps aux | grep -oP 'hostfwd=tcp::\K\d+' | head -1 || true)
        if [ -z "$SSH_PORT" ]; then
            SSH_PORT="2222"  # Default fallback
        fi
    else
        SSH_PORT="{{ ssh_port }}"
    fi

    echo "Using SPICE port: $SPICE_PORT, SSH port: $SSH_PORT"

    if ! ss -tlnp | grep -q ":$SPICE_PORT "; then
        echo "ERROR: QEMU VM not running (no SPICE on port $SPICE_PORT)"
        echo "Run 'just e2e' or 'just qemu-e2e-test-host' first."
        exit 1
    fi

    SSH_KEY="e2e/qemu-images/id_ed25519"
    SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $SSH_PORT testuser@localhost"
    # Wait for GDM login screen
    echo -n "Waiting for GDM..."
    for i in $(seq 1 30); do
        if $SSH "pgrep -x gdm >/dev/null 2>&1"; then
            echo " ready"
            break
        fi
        sleep 1
        echo -n "."
    done
    sleep 2
    # Wait for GNOME Shell to be ready
    echo -n "Waiting for desktop..."
    for i in $(seq 1 30); do
        if $SSH "pgrep -x gnome-shell >/dev/null 2>&1"; then
            echo " ready"
            break
        fi
        sleep 1
        echo -n "."
    done
    # Dismiss lock screen if present
    $SSH "echo 'key Escape' > /run/user/1000/dotool-pipe" 2>/dev/null || true
    sleep 0.5
    echo "Connecting to QEMU VM via SPICE (localhost:$SPICE_PORT)..."
    if flatpak list --app 2>/dev/null | grep -q org.virt_manager.virt-viewer; then
        flatpak run org.virt_manager.virt-viewer spice://localhost:$SPICE_PORT &
    elif command -v remote-viewer &>/dev/null; then
        remote-viewer spice://localhost:$SPICE_PORT &
    elif command -v remmina &>/dev/null; then
        remmina spice://localhost:$SPICE_PORT &
    else
        echo "No SPICE client found. Install one:"
        echo "  just install-spice-client"
        echo "  sudo dnf install virt-viewer"
        exit 1
    fi
    SPICE_PID=$!
    # Wait for window to appear, then tile to right half
    sleep 2
    if command -v dotool &>/dev/null; then
        echo "Tiling window to right half..."
        printf 'keydown leftmeta\nkey right\nkeyup leftmeta\n' | dotool
        sleep 0.5
        # Click on left side of screen to focus terminal
        printf 'mouseto 0.25 0.5\nclick left\n' | dotool
    fi
    wait $SPICE_PID 2>/dev/null || true
# @category e2e-qemu
qemu-install:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Installing QEMU/KVM on host via rpm-ostree..."
    rpm-ostree install qemu-kvm libvirt virt-install qemu-img
    echo "Packages staged. Run 'systemctl reboot' to activate."
# @category e2e-qemu
qemu-e2e-check:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Checking E2E prerequisites..."

    # Check QEMU
    if ! command -v qemu-system-x86_64 &>/dev/null; then
        echo "❌ qemu-system-x86_64 not found. Run 'just qemu-install' first."
        exit 1
    fi
    echo "✓ QEMU installed: $(qemu-system-x86_64 --version | head -1)"

    # Check KVM
    if ! lsmod | grep -q kvm; then
        echo "❌ KVM modules not loaded. Run 'sudo modprobe kvm kvm_intel' or 'kvm_amd'."
        exit 1
    fi
    echo "✓ KVM available"

    # Check base image (qemu-e2e-vm uses base.qcow2)
    if [[ ! -f "e2e/qemu-images/base.qcow2" ]]; then
        echo "❌ Base image not found (e2e/qemu-images/base.qcow2). See docs/e2e-setup.md for instructions."
        exit 1
    fi
    echo "✓ Base image found"

    # Check SSH key
    if [[ ! -f "e2e/qemu-images/id_ed25519" ]]; then
        echo "❌ SSH key not found. Generate with: ssh-keygen -t ed25519 -f e2e/qemu-images/id_ed25519"
        exit 1
    fi
    echo "✓ SSH key found"

    # Check cloud-init ISO (qemu-e2e-vm always attaches it)
    if [[ ! -f "e2e/qemu-images/cloud-init.iso" ]]; then
        echo "❌ cloud-init.iso not found. Run 'just qemu-e2e-create-base' first."
        exit 1
    fi
    echo "✓ cloud-init.iso found"

    # Check bun
    if ! command -v bun &>/dev/null; then
        echo "❌ bun not found. Install with: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
    echo "✓ bun installed"

    # Check npm deps
    if [[ ! -d "e2e/node_modules" ]]; then
        echo "Installing npm dependencies..."
        cd e2e && bun install
    fi
    echo "✓ npm dependencies installed"

    echo ""
    echo "All prerequisites met! Run 'just e2e' to execute tests."
# @category e2e-qemu
qemu-e2e-create-base:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Creating E2E base image..."
    echo ""
    echo "This script creates a QEMU base image for E2E testing."
    echo "See docs/e2e-setup.md for detailed instructions."
    echo ""

    VM_DIR="e2e/qemu-images"
    mkdir -p "$VM_DIR"

    # Check if image already exists
    if [[ -f "$VM_DIR/base.qcow2" ]]; then
        echo "Base image already exists: $VM_DIR/base.qcow2"
        echo "Delete it first or use 'just qemu-e2e-create-uv' to create UV-enhanced image."
        exit 1
    fi

    echo "Downloading Fedora Cloud image (this may take a few minutes)..."
    wget -O "$VM_DIR/base.qcow2" https://download.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2
    echo ""
    echo "Base image downloaded: $VM_DIR/base.qcow2"
    echo ""
    echo "Next steps:"
    echo "  1. Generate SSH key: ssh-keygen -t ed25519 -f $VM_DIR/id_ed25519"
    echo "  2. Install virt-customize: sudo dnf install -y libguestfs-tools"
    echo "  3. Customize image: see docs/e2e-setup.md Step 3"
    echo "  4. Run 'just qemu-e2e-create-uv' to create UV-enhanced image"
    echo "  5. Run 'just qemu-e2e-check' to verify all prerequisites."
# @category e2e-qemu
qemu-e2e-create-uv:
    ./e2e/scripts/create-base-with-uv.sh
# @category e2e-qemu
qemu-e2e-setup:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Setting up E2E test environment..."
    echo ""

    VM_DIR="e2e/qemu-images"
    MAIN_VM_DIR="../../main/e2e/qemu-images"
    mkdir -p "$VM_DIR"

    # 1. Golden image
    GOLDEN_FILE="$VM_DIR/golden-gnome-deps.qcow2"
    if [[ -f "$GOLDEN_FILE" ]]; then
        echo "✓ Golden image already exists: $GOLDEN_FILE"
    elif [[ -f "$MAIN_VM_DIR/golden-gnome-deps.qcow2" ]]; then
        echo "Copying golden image from main branch..."
        cp "$MAIN_VM_DIR/golden-gnome-deps.qcow2" "$GOLDEN_FILE"
        echo "✓ Copied: $GOLDEN_FILE"
    else
        echo "Downloading golden-gnome-deps.qcow2 from Filen..."
        if ! command -v filen &>/dev/null; then
            echo "❌ 'filen' CLI not found. Install it (npm i -g filen) or copy the golden image manually." >&2
            exit 1
        fi
        filen download "/golden-gnome-deps.qcow2" "$GOLDEN_FILE"
        echo "✓ Downloaded: $GOLDEN_FILE"
    fi
    echo ""

    # 2. SSH keys
    if [[ -f "$VM_DIR/id_ed25519" && -f "$VM_DIR/id_ed25519.pub" ]]; then
        echo "✓ SSH keys already exist"
    elif [[ -f "$MAIN_VM_DIR/id_ed25519" ]]; then
        echo "Copying SSH keys from main branch..."
        cp "$MAIN_VM_DIR/id_ed25519" "$VM_DIR/id_ed25519"
        cp "$MAIN_VM_DIR/id_ed25519.pub" "$VM_DIR/id_ed25519.pub"
        chmod 600 "$VM_DIR/id_ed25519"
        echo "✓ SSH keys copied: $VM_DIR/id_ed25519"
    else
        echo "Downloading SSH keys from Filen..."
        [[ -f "$VM_DIR/id_ed25519" ]] || filen download "/id_ed25519" "$VM_DIR/id_ed25519"
        [[ -f "$VM_DIR/id_ed25519.pub" ]] || filen download "/id_ed25519.pub" "$VM_DIR/id_ed25519.pub"
        chmod 600 "$VM_DIR/id_ed25519"
        echo "✓ SSH keys downloaded: $VM_DIR/id_ed25519"
    fi
    echo ""

    # 2b. Overlay with 'ready' snapshot (from main worktree, else Filen)
    OVERLAY_FILE="$VM_DIR/persistent-run/main/overlay.qcow2"
    if [[ -f "$OVERLAY_FILE" ]]; then
        echo "✓ Overlay already exists: $OVERLAY_FILE"
    elif [[ -f "$MAIN_VM_DIR/persistent-run/main/overlay.qcow2" ]]; then
        echo "Copying overlay from main branch..."
        mkdir -p "$(dirname "$OVERLAY_FILE")"
        cp "$MAIN_VM_DIR/persistent-run/main/overlay.qcow2" "$OVERLAY_FILE"
        echo "✓ Copied: $OVERLAY_FILE"
    else
        echo "Downloading overlay.qcow2 from Filen..."
        mkdir -p "$(dirname "$OVERLAY_FILE")"
        filen download "/overlay.qcow2" "$OVERLAY_FILE"
        echo "✓ Downloaded: $OVERLAY_FILE"
    fi
    echo ""

    # 3. Cloud-init ISO (required by QEMU boot)
    CLOUD_INIT="$VM_DIR/cloud-init.iso"
    if [[ -f "$CLOUD_INIT" ]]; then
        echo "✓ Cloud-init ISO already exists: $CLOUD_INIT"
    elif [[ -f "$MAIN_VM_DIR/cloud-init.iso" ]]; then
        echo "Copying cloud-init ISO from main branch..."
        cp "$MAIN_VM_DIR/cloud-init.iso" "$CLOUD_INIT"
        echo "✓ Copied: $CLOUD_INIT"
    else
        echo "Creating cloud-init ISO..."
        PUB_KEY=$(cat "$VM_DIR/id_ed25519.pub")
        TEMP_DIR=$(mktemp -d)
        mkdir -p "$TEMP_DIR/cloud-init"
        echo "#cloud-config" > "$TEMP_DIR/cloud-init/user-data"
        echo "users:" >> "$TEMP_DIR/cloud-init/user-data"
        echo "  - name: testuser" >> "$TEMP_DIR/cloud-init/user-data"
        echo "    ssh-authorized-keys:" >> "$TEMP_DIR/cloud-init/user-data"
        echo "      - $PUB_KEY" >> "$TEMP_DIR/cloud-init/user-data"
        echo "    sudo: ALL=(ALL) NOPASSWD:ALL" >> "$TEMP_DIR/cloud-init/user-data"
        echo "    groups: wheel,input" >> "$TEMP_DIR/cloud-init/user-data"
        echo "    shell: /bin/bash" >> "$TEMP_DIR/cloud-init/user-data"
        echo "" >> "$TEMP_DIR/cloud-init/user-data"
        echo "password: ''" >> "$TEMP_DIR/cloud-init/user-data"
        echo "chpasswd: { expire: false }" >> "$TEMP_DIR/cloud-init/user-data"
        echo "" >> "$TEMP_DIR/cloud-init/user-data"
        echo "package_update: false" >> "$TEMP_DIR/cloud-init/user-data"
        echo "packages: []" >> "$TEMP_DIR/cloud-init/user-data"
        echo "" >> "$TEMP_DIR/cloud-init/user-data"
        echo "runcmd:" >> "$TEMP_DIR/cloud-init/user-data"
        echo "  - systemctl set-default graphical.target" >> "$TEMP_DIR/cloud-init/user-data"
        if ! command -v mkisofs &>/dev/null && ! command -v genisoimage &>/dev/null; then
            echo "❌ mkisofs/genisoimage not found. Install genisoimage (dnf install genisoimage)." >&2
            exit 1
        fi
        if command -v mkisofs &>/dev/null; then
            mkisofs -output "$CLOUD_INIT" -volid cidata -joliet -rock "$TEMP_DIR/cloud-init" 2>/dev/null
        else
            genisoimage -output "$CLOUD_INIT" -volid cidata -joliet -rock "$TEMP_DIR/cloud-init" 2>/dev/null
        fi
        rm -rf "$TEMP_DIR"
        echo "✓ Cloud-init ISO created: $CLOUD_INIT"
    fi
    echo ""

    # 4. Create base.qcow2 overlay (backing image for VM runs)
    BASE_IMAGE="$VM_DIR/base.qcow2"
    if [[ -f "$BASE_IMAGE" ]]; then
        echo "✓ Base image already exists: $BASE_IMAGE"
    else
        echo "Creating base.qcow2 overlay from golden image..."
        qemu-img create -f qcow2 -b "$(realpath "$GOLDEN_FILE")" -F qcow2 "$BASE_IMAGE"
        echo "✓ Base image created: $BASE_IMAGE"
    fi
    echo ""

    echo "═══════════════════════════════════════════════════"
    echo "  E2E environment ready!"
    echo ""
    echo "  Images:"
    echo "    $GOLDEN_FILE"
    echo "    $CLOUD_INIT"
    echo ""
    echo "  Run tests:  just e2e"
    echo "═══════════════════════════════════════════════════"
# @category e2e-qemu
e2e-setup-vm:
    bash e2e/setup-vm.sh
# @category e2e-qemu
e2e-start:
    virsh -c qemu:///session start e2e
# @category e2e-qemu
e2e-stop:
    virsh -c qemu:///session destroy e2e
# @category e2e-qemu
e2e-record output='e2e/output/recording.mp4' port='5930':
    python3 e2e/lib/spice-record.py --host localhost --port {{ port }} --output {{ output }}

# @category e2e-vm
# Local CI-parity: set up the Ubuntu 26.04 VM (image download + customize)
ubuntu-vm-setup:
    ./e2e-vm/setup-vm.sh

# @category e2e-vm
# Local CI-parity: boot the Ubuntu 26.04 VM headless (idempotent).
# Overlay persists across runs; `just ubuntu-vm-boot fresh` resets to golden image.
ubuntu-vm-boot *args='':
    ./e2e-vm/boot-vm.sh {{ args }}

# @category e2e-vm
# Local CI-parity: boot the Ubuntu 26.04 VM with a visible desktop window
# (GTK display instead of headless). Same disk/SSH as ubuntu-vm-boot.
ubuntu-vm-boot-gui:
    #!/usr/bin/env bash
    set -euo pipefail
    cd e2e-vm
    if [ -f qemu.pid ] && kill -0 "$(cat qemu.pid)" 2>/dev/null; then
      echo "VM already running (PID $(cat qemu.pid)) — run 'just ubuntu-vm-kill' first" >&2
      exit 1
    fi
    [ -f golden-ubuntu-2604.qcow2 ] || { echo "Run 'just ubuntu-vm-setup' first" >&2; exit 1; }
    rm -f overlay.qcow2
    qemu-img create -f qcow2 -b golden-ubuntu-2604.qcow2 -F qcow2 overlay.qcow2 > /dev/null
    qemu-system-x86_64 \
      -enable-kvm -cpu host -m 4096 -smp 2 \
      -drive file=overlay.qcow2,format=qcow2,if=virtio \
      -device virtio-vga \
      -display gtk,gl=off \
      -monitor unix:qemu-monitor.sock,server,nowait \
      -serial file:serial.log \
      -netdev user,id=net0,hostfwd=tcp::2222-:22 \
      -device virtio-net-pci,netdev=net0 \
      -daemonize -pidfile qemu.pid
    # Wait for SSH before returning, mirroring boot-vm.sh, so a cold GUI boot
    # doesn't fail the parity run on its first ssh command.
    for i in $(seq 1 60); do
      if ssh -i id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 -p 2222 testuser@localhost echo ok 2>/dev/null; then
        echo "Ubuntu 26.04 desktop ready (GDM auto-login: testuser), SSH on :2222"
        exit 0
      fi
      sleep 3
    done
    echo "FATAL: SSH not ready after 180s" >&2
    exit 1

# @category e2e-vm
# Full local CI-parity cycle: boot Ubuntu 26.04 VM (if not running) + Parakeet
# + run the CI harness + stop the VM. Add GUI=1 for a visible desktop window.
ubuntu-vm-test GUI='':
    #!/usr/bin/env bash
    set -euo pipefail
    # Install the EXIT trap BEFORE booting, so a failed boot (QEMU up but SSH
    # never ready) can't leak the VM.
    trap 'just ubuntu-vm-kill' EXIT
    just ubuntu-vm-{{ if GUI == "1" { "boot-gui" } else { "boot" } }}
    just ubuntu-vm-parakeet
    just ubuntu-vm-run

# @category e2e-vm
# Local CI-parity: run the CI harness (ci-e2e-headless.sh) inside the VM.
# Requires Parakeet on the host: just ubuntu-vm-parakeet
ubuntu-vm-run:
    ./e2e-vm/run-parity.sh

# @category e2e-vm
# Start Parakeet on the host (port 5092) for the Ubuntu VM parity run
ubuntu-vm-parakeet:
    #!/usr/bin/env bash
    set -euo pipefail
    RUNTIME=docker
    command -v docker >/dev/null 2>&1 || RUNTIME=podman
    # Provision model files first — the container can pass /health without
    # models, but transcription would fail (mirrors e2e/lib/parakeet.ts).
    MODELS_DIR="${HOME}/parakeet/models"
    mkdir -p "$MODELS_DIR"
    if [ ! -f "$MODELS_DIR/config.json" ]; then
      echo "Downloading Parakeet models (first run on this host)..."
      BASE="https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main"
      for f in config.json vocab.txt encoder-model.int8.onnx decoder_joint-model.int8.onnx; do
        curl -sfL -o "$MODELS_DIR/$f" "$BASE/$f"
      done
    fi
    $RUNTIME rm -f parakeet-e2e-parity >/dev/null 2>&1 || true
    $RUNTIME run -d --name parakeet-e2e-parity --network host \
      -v "$MODELS_DIR":/models:Z \
      ghcr.io/achetronic/parakeet:latest > /dev/null
    for i in $(seq 1 60); do
      curl -sf http://localhost:5092/health >/dev/null && { echo "Parakeet ready"; exit 0; }
      sleep 2
    done
    echo "FATAL: Parakeet not ready" >&2; exit 1

# @category e2e-vm
# Stop the Ubuntu 26.04 parity VM
ubuntu-vm-kill:
    #!/usr/bin/env bash
    PID_FILE="e2e-vm/qemu.pid"
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE")"
      # Verify the PID actually belongs to QEMU before killing — the pid file
      # may be stale and the PID reused by an unrelated process.
      if ps -p "$PID" -o comm= 2>/dev/null | grep -q qemu; then
        kill "$PID" 2>/dev/null || true
      fi
      rm -f "$PID_FILE"
    fi
    echo "VM stopped"
