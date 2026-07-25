# Custom container for visual regression testing of the GNOME extension.
# Extends gnome-shell-pod-41 (Fedora 41, GNOME 47) with Python D-Bus service for E2E testing.
# NOTE: This is a DEBUG/E2E build that includes voice_to_text/debug.py
# For production builds, remove debug.py after copying:
#   RUN rm -f /app/src/voice_to_text/debug.py
# The debug module provides VOICE_TO_TEXT_DEBUG_FILE support for testing
# with pre-recorded audio files instead of a microphone.

# Build stage: compile dotool from source
FROM fedora:rawhide AS dotool-builder
RUN dnf install -y --nogpgcheck golang git libxkbcommon-devel pkgconf && dnf clean all
RUN git clone https://git.sr.ht/~geb/dotool /tmp/dotool && \
    cd /tmp/dotool && go build -ldflags "-X main.Version=1.0"

# Main stage
FROM ghcr.io/schneegans/gnome-shell-pod-41

# Copy dotool from builder (dotool is a Go binary; dotoolc and dotoold are shell scripts)
COPY --from=dotool-builder /tmp/dotool/dotool /usr/local/bin/dotool
COPY --from=dotool-builder /tmp/dotool/dotoolc /usr/local/bin/dotoolc
COPY --from=dotool-builder /tmp/dotool/dotoold /usr/local/bin/dotoold

# Install system packages (ImageMagick, zip, etc.)
# Enable user session lingering so D-Bus session bus starts at boot
# (can't use loginctl during build - systemd not running as PID 1)
RUN mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/gnomeshell
USER root
RUN dnf install -y --nogpgcheck ImageMagick zip portaudio-devel python3-numpy python3-cffi python3-yaml glib2 pipewire-utils xdotool \
    gtk4 gstreamer1 gstreamer1-plugins-base gstreamer1-plugins-good && \
    dnf clean all

# Install uv and create a venv with pinned Python 3.13
# This avoids the dnf Python 3.13→3.15 upgrade entirely
RUN curl -LsSf https://astral.sh/uv/install.sh -o /tmp/install-uv.sh && \
    bash /tmp/install-uv.sh && rm /tmp/install-uv.sh
ENV PATH="/root/.local/bin:${PATH}"
RUN uv python install 3.13 && \
    uv venv --python 3.13 /app-venv && \
    chmod 755 /root

# Install Python packages into the venv (no patching needed on 3.13)
RUN uv pip install --python /app-venv/bin/python \
    dbus-next httpx sounddevice numpy pyyaml python-dotenv websockets \
    groq mistralai


# Disable GNOME welcome tour by pre-seeding dconf database
# This must be set BEFORE GNOME Shell starts (at build time, not runtime)
RUN mkdir -p /etc/dconf/db/local.d && \
    echo '[org/gnome/shell]' > /etc/dconf/db/local.d/00-gnome-shell && \
    echo "welcome-dialog-last-shown-version='4294967295'" >> /etc/dconf/db/local.d/00-gnome-shell && \
    dconf update

# Use smaller screen for faster tests (800x600) and display :100 to avoid host conflicts
RUN sed -i 's/1920x1080x24/800x600x24/' /etc/systemd/system/xvfb@.service && \
    rm -f /etc/systemd/system/multi-user.target.wants/xvfb@:99.service && \
    ln -s /etc/systemd/system/xvfb@.service /etc/systemd/system/multi-user.target.wants/xvfb@:100.service

# Copy the project source
COPY . /app
WORKDIR /app

# Build the GNOME extension ZIP
RUN mkdir -p /app/tests/e2e/expected && bash /app/tests/e2e/scripts/build-ext-zip.sh

# Install Python voice-to-text package into the venv
RUN VENV_SITE="/app-venv/lib/python3.13/site-packages" && \
    cp -r /app/src/voice_to_text "${VENV_SITE}/" && \
    mkdir -p /home/gnomeshell/.local/share/dbus-1/services/ /home/gnomeshell/.local/bin/ /home/gnomeshell/.config/voice-to-text && \
    # Write D-Bus service file with inline env sourcing (avoids timing issues)
    # The env file is written before GNOME Shell starts, so it will be available
    echo '[D-BUS Service]' > /home/gnomeshell/.local/share/dbus-1/services/com.happytomatoe.VoiceToText.service && \
    echo 'Name=com.happytomatoe.VoiceToText' >> /home/gnomeshell/.local/share/dbus-1/services/com.happytomatoe.VoiceToText.service && \
    echo 'Exec=/bin/sh -c '\"'. /home/gnomeshell/.config/voice-to-text/env 2>/dev/null; exec /app-venv/bin/python -m voice_to_text'\"'' >> /home/gnomeshell/.local/share/dbus-1/services/com.happytomatoe.VoiceToText.service && \
    cp /app/tests/e2e/fixtures/voice-to-text.conf /home/gnomeshell/.config/voice-to-text/config.yaml && \
    echo '#!/bin/sh' > /home/gnomeshell/.local/bin/voice-to-text-dbus && \
    echo '# Source environment variables if they exist' >> /home/gnomeshell/.local/bin/voice-to-text-dbus && \
    echo 'test -f /home/gnomeshell/.config/voice-to-text/env && . /home/gnomeshell/.config/voice-to-text/env' >> /home/gnomeshell/.local/bin/voice-to-text-dbus && \
    echo 'exec /app-venv/bin/python -m voice_to_text "$@"' >> /home/gnomeshell/.local/bin/voice-to-text-dbus && \
    chmod +x /home/gnomeshell/.local/bin/voice-to-text-dbus && \
    chown -R gnomeshell:users /home/gnomeshell/.local /home/gnomeshell/.config

# Make venv available to the gnomeshell user
RUN echo 'export PATH="/app-venv/bin:$PATH"' >> /etc/profile.d/venv.sh && \
    chmod +x /etc/profile.d/venv.sh

# Ensure output directories exist
RUN mkdir -p /app/tests/e2e-output

# USER gnomeshell — don't set here; systemd needs root as PID 1
WORKDIR /home/gnomeshell
