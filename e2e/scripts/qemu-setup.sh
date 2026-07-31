#!/bin/bash
# QEMU VM setup for E2E testing.
# Creates a Fedora 44 VM with GNOME Shell, audio loopback, Python backend,
# and the voice-to-text extension ready for testing.
#
# Runs inside the fedora-toolbox-44 container where QEMU is installed.
# Usage: podman exec fedora-toolbox-44 bash /path/to/qemu-setup.sh

set -euo pipefail

VM_DIR="${REPO_ROOT}/e2e/qemu-images"
BASE_IMAGE="${VM_DIR}/base.qcow2"
CLOUD_IMAGE="${VM_DIR}/fedora44.qcow2"
SEED_ISO="${VM_DIR}/seed.iso"
USER_DATA="${VM_DIR}/user-data"
META_DATA="${VM_DIR}/meta-data"
SSH_KEY="${VM_DIR}/id_ed25519"
EXTENSION_SRC="${VM_DIR}/gnome-ext"
TEST_AUDIO="${VM_DIR}/test-audio.wav"
REPO_ROOT="${REPO_ROOT:-/var/home/l/git/voice-to-text-test-pod}"

SSH_USER="testuser"
SSH_PASS="fedoraci"
SSH_PORT=2222
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
SCP_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

Fedora_CLOUD_URL="https://dl.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2"

mkdir -p "${VM_DIR}"

# ─── Step 1: Download Fedora cloud image ────────────────────────────────
if [[ ! -f "${CLOUD_IMAGE}" ]]; then
    echo "Downloading Fedora 44 cloud image..."
    curl -L -o "${CLOUD_IMAGE}" "${Fedora_CLOUD_URL}"
fi

# ─── Step 2: Create base qcow2 from cloud image ────────────────────────
if [[ ! -f "${BASE_IMAGE}" ]]; then
    echo "Creating base image..."
    qemu-img create -f qcow2 -b "${CLOUD_IMAGE}" -F qcow2 "${BASE_IMAGE}" 20G
fi

# ─── Step 3: Generate SSH key pair ─────────────────────────────────────
if [[ ! -f "${SSH_KEY}" ]]; then
    echo "Generating SSH key..."
    ssh-keygen -t ed25519 -f "${SSH_KEY}" -N "" -C "qemu-e2e"
fi

# ─── Step 4: Create cloud-init config ──────────────────────────────────
cat > "${USER_DATA}" << 'USERDATA'
#cloud-config
users:
  - name: testuser
    password: fedoraci
    lock_passwd: false
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - REPLACE_SSH_KEY_PLACEHOLDER

packages:
  - spice-vdagent
  - openssh-server
  - gnome-shell
  - gnome-session
  - gnome-terminal
  - dbus-x11
  - xorg-x11-server-Xorg
  - xorg-x11-server-Xvnc
  - pipewire-utils
  - pulseaudio-utils
  - python3-pip
  - python3-devel
  - portaudio-devel
  - git
  - make
  - gcc
  - tmux
  - gcc

runcmd:
  - systemctl stop sshd.socket
  - systemctl disable sshd.socket
  - systemctl mask sshd.socket
  - systemctl enable sshd.service
  - systemctl restart sshd.service
  - systemctl set-default multi-user.target
  - grubby --update-kernel=ALL --args="rd.device.wait=0"
  - echo "testuser:fedoraci" | chpasswd
USERDATA

# Inject actual SSH key (PUB_KEY includes type prefix, e.g. ssh-ed25519 AAAA...)
PUB_KEY=$(cat "${SSH_KEY}.pub")
sed -i "s|REPLACE_SSH_KEY_PLACEHOLDER|${PUB_KEY}|" "${USER_DATA}"

cat > "${META_DATA}" << 'METADATA'
instance-id: voice-to-text-e2e
local-hostname: e2e-vm
METADATA

# ─── Step 5: Create cloud-init seed ISO ────────────────────────────────
if [[ ! -f "${SEED_ISO}" ]]; then
    echo "Creating cloud-init seed ISO..."
    mkisofs -output "${SEED_ISO}" -volid cidata -joliet -rock \
        "${USER_DATA}" "${META_DATA}"
fi

# ─── Step 6: Boot VM ──────────────────────────────────────────────────
echo "Booting VM..."
cd "${VM_DIR}"

# Kill any existing QEMU
pkill -9 -f "qemu-system-x86" 2>/dev/null || true
sleep 2
rm -f qemu-monitor.sock serial.log

qemu-system-x86_64 \
    -enable-kvm \
    -cpu host \
    -m 4096 \
    -smp 2 \
    -drive file="${BASE_IMAGE}",format=qcow2,if=virtio \
    -drive file="${SEED_ISO}",format=raw,if=virtio,readonly=on \
    -device virtio-vga \
    -display vnc=:1 \
    -monitor unix:qemu-monitor.sock,server,nowait \
    -serial file:serial.log \
    -netdev user,id=net0,hostfwd=tcp::${SSH_PORT}-:22 \
    -device virtio-net-pci,netdev=net0 \
    -no-reboot &

QEMU_PID=$!
echo "QEMU started (PID: ${QEMU_PID})"

# ─── Step 7: Wait for SSH ─────────────────────────────────────────────
echo -n "Waiting for SSH"
for i in $(seq 1 60); do
    if ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} \
        ${SSH_USER}@localhost echo ok >/dev/null 2>&1; then
        echo " ready (${i}s)"
        break
    fi
    echo -n "."
    sleep 2
done

if ! ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} \
    ${SSH_USER}@localhost echo ok >/dev/null 2>&1; then
    echo " TIMEOUT"
    exit 1
fi

# Wait for cloud-init to finish
echo "Waiting for cloud-init..."
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost \
    "while [ ! -f /var/lib/cloud/instance/boot-finished ]; do sleep 2; done" 2>/dev/null || true

# ─── Step 7b: Ensure required packages are installed ─────────────────
echo "Ensuring required packages..."
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost \
    "sudo dnf install -y gnome-shell gnome-terminal dbus-x11 xorg-x11-server-Xorg pipewire-utils pulseaudio-utils python3-pip python3-devel portaudio-devel git make gcc libev-devel systemd-devel golang libxkbcommon-devel" 2>/dev/null || true

# ─── Step 7d: Build and install dotool from source ──────────────────────
echo "Building dotool from source..."
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost << 'DTOOL_SETUP'
# Build dependencies are already installed via dnf above

# Clone and build dotool (clean slate for idempotency)
rm -rf /tmp/dotool
cd /tmp
git clone --branch 1.6 --depth 1 https://git.sr.ht/~geb/dotool
cd dotool && ./build.sh

# Install to ~/.local/bin
mkdir -p ~/.local/bin
cp dotool dotoolc dotoold ~/.local/bin/

# Configure permissions for /dev/uinput
sudo groupadd -f input
sudo usermod -aG input testuser
echo 'KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/80-dotool.rules
sudo udevadm control --reload && sudo udevadm trigger

echo "dotool installed"
DTOOL_SETUP
# ─── Step 7c: Disable GNOME welcome tour ────────────────────────────
echo "Disabling GNOME welcome tour..."
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost << 'TOUR_DISABLE'
sudo mkdir -p /etc/dconf/db/local.d
echo '[org/gnome/shell]' | sudo tee /etc/dconf/db/local.d/00-gnome-shell > /dev/null
echo "welcome-dialog-last-shown-version='4294967295'" | sudo tee -a /etc/dconf/db/local.d/00-gnome-shell > /dev/null
echo "development-tools=true" | sudo tee -a /etc/dconf/db/local.d/00-gnome-shell > /dev/null
sudo dconf update
TOUR_DISABLE

# ─── Step 7e: Configure GDM auto-login and graphical target ──────────
echo "Configuring GDM auto-login..."
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost << 'GDM_SETUP'
sudo systemctl set-default graphical.target
sudo tee /etc/gdm/custom.conf > /dev/null << 'EOF'
[daemon]
AutomaticLoginEnable=True
AutomaticLogin=testuser
WaylandEnable=true
EOF
sudo systemctl enable gdm
GDM_SETUP

# ─── Step 8: Install Python dependencies ───────────────────────────────
echo "Installing Python dependencies..."
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost \
    "sudo dnf install -y python3-pip && pip3 install --user groq sounddevice numpy pyyaml python-dotenv httpx websockets dbus-next 'mistralai[realtime]'"

# ─── Step 9: Copy Python backend ──────────────────────────────────────
echo "Deploying Python backend..."
scp -i "${SSH_KEY}" ${SCP_OPTS} -P ${SSH_PORT} -r \
    "${REPO_ROOT}/src/voice_to_text" ${SSH_USER}@localhost:~/voice_to_text

# ─── Step 10: Copy test audio file ────────────────────────────────────
echo "Copying test audio..."
scp -i "${SSH_KEY}" ${SCP_OPTS} -P ${SSH_PORT} \
    "${REPO_ROOT}/e2e/fixtures/test-audio.wav" ${SSH_USER}@localhost:/tmp/test-audio.wav

# ─── Step 11: Install audio packages ──────────────────────────────────
echo "Installing audio packages..."
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost \
    "sudo dnf install -y pipewire-utils pulseaudio-utils" 2>/dev/null || true

# ─── Step 12: Deploy GNOME extension ──────────────────────────────────
echo "Deploying GNOME extension..."
EXT_DEST="/home/${SSH_USER}/.local/share/gnome-shell/extensions/voice-to-text@happytomatoe.com"
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost "mkdir -p ${EXT_DEST}/schemas"
scp -i "${SSH_KEY}" ${SCP_OPTS} -P ${SSH_PORT} \
    "${REPO_ROOT}/gnome-ext/"*.js \
    "${REPO_ROOT}/gnome-ext/"*.json \
    "${REPO_ROOT}/gnome-ext/"*.css \
    ${SSH_USER}@localhost:"${EXT_DEST}/" 2>/dev/null || true
scp -i "${SSH_KEY}" ${SCP_OPTS} -P ${SSH_PORT} \
    "${REPO_ROOT}/gnome-ext/schemas/"* \
    ${SSH_USER}@localhost:"${EXT_DEST}/schemas/"

# ─── Step 13: Install gsettings schema ────────────────────────────────
echo "Installing gsettings schema..."
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost << 'SCHEMA_SETUP'
sudo cp ~/.local/share/gnome-shell/extensions/voice-to-text@happytomatoe.com/schemas/gschemas.compiled /usr/share/glib-2.0/schemas/
sudo glib-compile-schemas /usr/share/glib-2.0/schemas/
SCHEMA_SETUP

# ─── Step 14: Create D-Bus service startup script ─────────────────────
echo "Creating service startup script..."
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost << 'SERVICE_SETUP'
cat > ~/start-service.sh << 'EOF'
#!/bin/bash
export DISPLAY=:0
export DBUS_SESSION_BUS_ADDRESS=$(cat /tmp/dbus-address 2>/dev/null || echo "")
export DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-}
export VOICE_TO_TEXT_DEBUG_FILE=/tmp/test-audio.wav
export PYTHONPATH=~/voice_to_text/..

pkill -f "python3 -m voice_to_text" 2>/dev/null
sleep 1

cd ~
nohup python3 -m voice_to_text > /tmp/voice-service.log 2>&1 &
echo "Service started with PID $!"
sleep 2
cat /tmp/voice-service.log
EOF
chmod +x ~/start-service.sh
SERVICE_SETUP

# ─── Step 15: Create GNOME startup script ─────────────────────────────
echo "Creating GNOME startup script..."
ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost << 'GNOME_SETUP'
cat > ~/start-gnome.sh << 'EOF'
#!/bin/bash
export DISPLAY=:0

# Start Xorg
sudo Xorg :0 -configure 2>/dev/null
nohup sudo Xorg :0 &
sleep 2

# Find the D-Bus session address from GNOME Shell's environment
# (we'll save it after starting gnome-shell)
eval $(dbus-launch --sh-syntax)
echo "$DBUS_SESSION_BUS_ADDRESS" > /tmp/dbus-address

# Start GNOME Shell
nohup gnome-shell --mode=user &>/tmp/gnome-shell.log &
sleep 3

# Enable extension
export DBUS_SESSION_BUS_ADDRESS
gnome-extensions enable voice-to-text@happytomatoe.com 2>/dev/null || true

# Set provider to deepgram
gsettings set org.gnome.shell.extensions.voice-to-text provider deepgram 2>/dev/null || true

echo "GNOME Shell started"
EOF
chmod +x ~/start-gnome.sh
GNOME_SETUP

# ─── Step 16: Shut down VM ────────────────────────────────────────────
echo "Shutting down VM..."
echo "system_powerdown" | socat - UNIX-CONNECT:qemu-monitor.sock 2>/dev/null || true
sleep 5

# Force kill if still running
kill ${QEMU_PID} 2>/dev/null || true
wait ${QEMU_PID} 2>/dev/null || true

echo ""
echo "✅ Base VM image ready: ${BASE_IMAGE}"
echo "   To run tests: just qemu-e2e-test"
