import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ShellHelper } from "./shell.js";
import { Deployer } from "./deploy.js";
import { pollUntil, pollForProcess, pollForCommandOutput } from "./poll.js";
import { timeoutMs } from "./config.js";

// --- SSH exec helpers (sync, for quick one-off commands) ---

function sshOpts(sshKey: string, sshPort: number): string {
  return `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -i ${sshKey} -p ${sshPort}`;
}

export function sshExec(command: string, sshKey: string, sshPort: number, sshUser = "testuser", retries = 3, timeoutMs = 30000): string {
  if (retries < 1) retries = 1;
  const host = `${sshUser}@localhost`;
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(`ssh ${sshOpts(sshKey, sshPort)} ${host} "${command}"`, { timeout: timeoutMs }).toString();
    } catch (err) {
      lastErr = err as Error;
      // Remote command returned non-zero — still capture stdout (e.g. rpm -q, pgrep)
      if ((err as any).stdout) return (err as any).stdout.toString();
      if (i < retries - 1) {
        execSync(`sleep 2`);
      }
    }
  }
  throw lastErr!;
}

export function rsyncToVm(src: string, dest: string, sshKey: string, sshPort: number, sshUser = "testuser"): void {
  const host = `${sshUser}@localhost`;
  execSync(`rsync -azc --delete --delete-excluded -e "ssh ${sshOpts(sshKey, sshPort)}" ${src}/ ${host}:${dest}/`, { stdio: "pipe" });
}

export function scpToVm(src: string, dest: string, sshKey: string, sshPort: number, sshUser = "testuser"): void {
  const host = `${sshUser}@localhost`;
  const scpOpts = `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${sshKey} -P ${sshPort}`;
  execSync(`scp ${scpOpts} ${src} ${host}:${dest}`, { stdio: "pipe" });
}

// --- Shell-exec via SSH (shell-use PTY is broken on CI) ---
function shellExec(cmd: string, sshKey: string, sshPort: number, sshUser = "testuser"): string {
  return sshExec(cmd, sshKey, sshPort, sshUser, 1, 30_000);
}

// --- Deployment config ---

export interface DeployConfig {
  projectRoot: string;
  pythonSrc: string;
  fixtureDir: string;
  sshKey: string;
  sshPort: number;
  sshUser: string;
  extensionUuid: string;
  testAudioFile: string;
  outputMethod?: string; // Output method to test: type, clipboard, mutter-virtual
}

// --- Deployment steps ---

export async function waitForGdmLogin(
  shell: ShellHelper,
  sshKey: string,
  sshPort: number,
  sshUser = "testuser",
  serialLog?: string
): Promise<void> {
  const t0 = Date.now();

  // Use sshExec for all commands (shell-use PTY is broken on CI — commands return empty).

  // Check for critical missing packages (friend's advice: these cause silent crashes)
  const pkgCheck = shellExec(
    "rpm -q mesa-libgbm mesa-dri-drivers polkit accountsservice gsettings-desktop-schemas 2>&1",
    sshKey, sshPort, sshUser
  );
  const missingLines = pkgCheck.split("\n").filter(l => l.includes("not installed"));
  if (missingLines.length > 0) {
    console.log(`  WARNING: missing packages: ${missingLines.join(", ")}`);
  }

  // Configure journald to forward to serial console (friend's advice: captures OOM kills)
  // This writes kernel + systemd logs to serial.log on the host
  shellExec(
    "sudo sed -i 's/^#ForwardToConsole=no/ForwardToConsole=yes/' /etc/systemd/journald.conf 2>/dev/null || true",
    sshKey, sshPort, sshUser
  );
  shellExec("sudo systemctl restart systemd-journald 2>/dev/null || true", sshKey, sshPort, sshUser);

  // Disable animations to reduce llvmpipe GPU/CPU load (friend's advice)
  shellExec(
    "dconf write /org/gnome/desktop/interface/enable-animations false 2>/dev/null || true",
    sshKey, sshPort, sshUser
  );

  // Log memory state before starting gnome-shell (helps diagnose OOM kills)
  const memInfo = shellExec("free -m 2>/dev/null | head -2 || true", sshKey, sshPort, sshUser);
  console.log(`  memory before gnome-shell:\n${memInfo}`);
  // Start GNOME Shell in headless mode on the existing session bus.
  // Use 1280x720 instead of 1920x1080 to reduce llvmpipe memory/CPU pressure.
  shellExec(
    "export XDG_RUNTIME_DIR=/run/user/$(id -u) && " +
    "nohup gnome-shell --headless --unsafe-mode --virtual-monitor 1280x720 > /tmp/gnome-shell.log 2>&1 &",
    sshKey, sshPort, sshUser
  );
  console.log(`  gnome-shell start: ${Date.now() - t0}ms [time]`);

  // Poll for gnome-shell process (up to 30s, checking every 5s)
  const t1 = Date.now();
  let ready = false;
  for (let i = 0; i < 6; i++) {
    await Bun.sleep(5_000);
    try {
      const result = shellExec(`pgrep -x gnome-shell && echo ready`, sshKey, sshPort, sshUser);
      console.log(`  pgrep attempt ${i + 1}: ${JSON.stringify(result.slice(0, 100))}`);
      if (result.includes("ready")) {
        ready = true;
        break;
      }
    } catch (e) {
      console.log(`  pgrep attempt ${i + 1} failed: ${String(e).slice(0, 100)}`);
    }
  }
  if (!ready) {
    // Check if gnome-shell crashed
    try {
      const log = shellExec(`cat /tmp/gnome-shell.log 2>/dev/null | tail -20`, sshKey, sshPort, sshUser);
      console.log(`  gnome-shell log:\n${log.slice(0, 500)}`);
      if (log && /segfault|signal|crash|error.*xwayland/i.test(log)) {
        console.log(`  gnome-shell CRASHED:\n${log}`);
      }
    } catch {
      // ignore
    }
  }
  console.log(`  gnome-shell ready: ${Date.now() - t1}ms [time]`);
  console.log(`  GDM login total: ${Date.now() - t0}ms [time]`);

  if (!ready) {
    // Dump debug info using sshExec (fresh connections, unlike stale shell session)
    try {
      const log = sshExec("cat /tmp/gnome-shell.log 2>/dev/null || echo '(no log)'", sshKey, sshPort, sshUser, 1, 10_000);
      console.log(`  gnome-shell final log:\n${log}`);
    } catch {
      console.log("  (could not read gnome-shell log)");
    }
    try {
      const ps = sshExec("ps aux | grep gnome-shell || true", sshKey, sshPort, sshUser, 1, 10_000);
      console.log(`  gnome-shell processes:\n${ps}`);
    } catch {
      // ignore
    }
    // Read serial log (on host filesystem, survives SSH death — friend's advice)
    if (serialLog) {
      try {
        if (existsSync(serialLog)) {
          const serial = readFileSync(serialLog, "utf-8");
          const last50 = serial.split("\n").slice(-50).join("\n");
          console.log(`  serial log (last 50 lines):\n${last50}`);
        } else {
          console.log("  (serial.log not found on host)");
        }
      } catch {
        // ignore
      }
    }
    throw new Error("gnome-shell did not start — cannot continue without a running shell");
  }
}

export async function installDependencies(
  _sshKey: string,
  _sshPort: number,
  _sshUser: string
): Promise<void> {
  const t0 = Date.now();

  // Install GDM + GNOME Shell if not present (base cloud image is headless)
  try {
    const gdmCheck = sshExec("rpm -q gdm 2>/dev/null || echo missing", _sshKey, _sshPort, _sshUser);
    if (gdmCheck.includes("missing")) {
      console.log("  Installing GDM + GNOME Shell...");
      sshExec("sudo dnf install -y gdm gnome-shell 2>/dev/null", _sshKey, _sshPort, _sshUser);
    }
  } catch {
    // Continue — GDM install may fail on some images
  }

  // Install gnome-terminal if not present (needed for tmux in E2E tests)
  try {
    const termCheck = sshExec("which gnome-terminal 2>/dev/null || echo missing", _sshKey, _sshPort, _sshUser);
    if (termCheck.includes("missing")) {
      console.log("  Installing gnome-terminal...");
      sshExec("sudo dnf install -y gnome-terminal 2>/dev/null", _sshKey, _sshPort, _sshUser);
    }
  } catch {
    // Continue — tmux may work without it depending on test flow
  }
  // Install Ghostty via COPR (for testing mutter-paste clipboard behavior)
  try {
    const ghosttyCheck = sshExec("which ghostty 2>/dev/null || echo missing", _sshKey, _sshPort, _sshUser);
    if (ghosttyCheck.includes("missing")) {
      console.log("  Installing Ghostty via COPR...");
      sshExec("sudo dnf copr enable -y scottames/ghostty 2>/dev/null && sudo dnf install -y ghostty 2>/dev/null", _sshKey, _sshPort, _sshUser);
    }
  } catch {
    // Continue — Ghostty install may fail, fall back to gnome-terminal
  }
  console.log(`  dependencies total: ${Date.now() - t0}ms [time]`);
}

// extractDbusAddress removed — callers use getShellDbusAddr() in shell.ts instead

export async function deployExtension(
  shell: ShellHelper,
  cfg: DeployConfig,
  pollUntilFn: typeof pollUntil,
  deployer?: Deployer
): Promise<void> {
  const extDir = join(cfg.projectRoot, "gnome-ext");
  if (!existsSync(extDir)) return;

  const t0 = Date.now();
  console.log("Deploying GNOME extension via install.sh...");
  
  // Upload install.sh and gnome-ext to VM, then run install.sh --local
  const tUpload = Date.now();
  if (deployer) {
    await deployer.exec('mkdir -p ~/tmp-deploy');
    await deployer.uploadFile(join(cfg.projectRoot, 'install.sh'), '~/tmp-deploy/install.sh');
    await deployer.uploadDir(extDir, '~/tmp-deploy/gnome-ext');
  } else {
    sshExec(`mkdir -p ~/tmp-deploy`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
    rsyncToVm(join(cfg.projectRoot, 'install.sh'), '~/tmp-deploy/install.sh', cfg.sshKey, cfg.sshPort, cfg.sshUser);
    rsyncToVm(extDir, '~/tmp-deploy/gnome-ext', cfg.sshKey, cfg.sshPort, cfg.sshUser);
  }
  console.log(`    upload: ${Date.now() - tUpload}ms [time]`);
  
  const tInstall = Date.now();
  if (deployer) {
    await deployer.exec('chmod +x ~/tmp-deploy/install.sh && bash ~/tmp-deploy/install.sh --local ~/tmp-deploy/gnome-ext', timeoutMs("install_sh"));
  } else {
    sshExec(`chmod +x ~/tmp-deploy/install.sh && bash ~/tmp-deploy/install.sh --local ~/tmp-deploy/gnome-ext`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  }
  console.log(`    install.sh: ${Date.now() - tInstall}ms [time]`);
  
  const tDconf = Date.now();
  shellExec(`dconf write /org/gnome/shell/enabled-extensions "['${cfg.extensionUuid}']"`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  shellExec(`dconf write /org/gnome/shell/disable-user-extensions false`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  shellExec(`cat > /tmp/dconf-set.sh << 'SCRIPT'
#!/bin/bash
dconf write /org/gnome/shell/extensions/voice-to-text/provider "'parakeet'"
dconf write /org/gnome/shell/extensions/voice-to-text/custom-words "['herdr', 'command', 'PR']"
SCRIPT
chmod +x /tmp/dconf-set.sh && bash /tmp/dconf-set.sh`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  console.log(`    dconf: ${Date.now() - tDconf}ms [time]`);
  console.log(`  install.sh+dconf: ${Date.now() - t0}ms [time]`);

  // Disconnect deployer before GDM restart
  if (deployer) {
    await deployer.disconnect();
  }

  // Restart GDM to load the extension.
  // Note: org.gnome.Shell.Eval is disabled in GNOME 50, so D-Bus loading
  // and global.reexec_self() are not available. GDM restart is the only way.
  console.log("Restarting GDM to load extension...");
  // Ensure GDM auto-login is configured (base image may not have it)
  const gdmConf = `[daemon]\nAutomaticLoginEnable=True\nAutomaticLogin=${cfg.sshUser}\nWaylandEnable=true\n\n[security]\n\n[debug]\n`;
  try {
    sshExec(`echo '${gdmConf}' | sudo tee /etc/gdm/custom.conf > /dev/null`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  } catch {
    // May fail if already configured — continue
  }
  
  let extensionFound = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    console.log(`  attempt ${attempt + 1}...`);
    try {
      sshExec("sudo systemctl restart gdm", cfg.sshKey, cfg.sshPort, cfg.sshUser);
    } catch {
      // Expected: GDM restart drops the SSH connection mid-command
    }

    // Wait for GDM to fully restart and create a new user session
    console.log("  waiting for GDM to stabilize...");
    await Bun.sleep(5000);

    // Poll for GDM to be active (new session created)
    await pollUntilFn(
      "GDM active after restart",
      async () => {
        try {
          const result = sshExec("systemctl is-active gdm", cfg.sshKey, cfg.sshPort, cfg.sshUser);
          return result.trim() === "active";
        } catch {
          return false;
        }
      },
      30000
    );

    // Re-establish SSH session
    console.log("  re-establishing SSH session...");
    await shell.close();
    await shell.openSshSession({ sshKey: cfg.sshKey, sshPort: cfg.sshPort, sshUser: cfg.sshUser });
    // Re-establish deployer SSH connection (stale after GDM restart)
    if (deployer) {
      await deployer.disconnect();
      await deployer.connect();
    }

    // Wait for user session to be ready (GDM auto-login creates the session)
    // This must happen BEFORE checking for gnome-shell — gnome-shell only starts
    // after the user session is created and systemd --user is running.
    const t2 = Date.now();
    await pollUntilFn(
      "user session ready",
      async () => {
        try {
          // Check if the user's D-Bus session bus socket exists
          const result = shellExec(
            `test -S /run/user/$(id -u)/bus && echo ready`,
            cfg.sshKey, cfg.sshPort, cfg.sshUser
          );
          return result.includes("ready");
        } catch {
          return false;
        }
      },
      30000
    );
    console.log(`  user session ready: ${Date.now() - t2}ms [time]`);

    // Now wait for GNOME Shell to register on D-Bus (same method as initial login)
    const t3 = Date.now();
    try {
      shellExec("gdbus wait --session --timeout=60 org.gnome.Shell", cfg.sshKey, cfg.sshPort, cfg.sshUser);
    } catch {
      // gdbus wait may fail if shell is already up — check pgrep as fallback
      await pollForProcess((cmd: string) => Promise.resolve(shellExec(cmd, cfg.sshKey, cfg.sshPort, cfg.sshUser)), "gnome-shell --mode=user", 30000);
    }
    console.log(`  gnome-shell ready: ${Date.now() - t3}ms [time]`);

    // Poll for GNOME Shell extension system to be ready
    await pollUntilFn(
      "extension system ready",
      async () => {
        try {
          const result = shellExec(`gnome-extensions list 2>&1`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
          // Must contain our extension UUID (not just any text without "error")
          return result.includes(cfg.extensionUuid);
        } catch {
          return false;
        }
      },
      15000
    );
    console.log(`  GDM restart+SSH: ${Date.now() - t2}ms [time]`);

    // Wait for extension to be available
    console.log("  waiting for extension...");
    try {
      await pollUntilFn(
        "extension available",
        async () => {
          try {
            const result = sshExec(`gnome-extensions show ${cfg.extensionUuid} 2>&1`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
            // Extension must exist AND be in ACTIVE state (not just INITIALIZED/ENABLED)
            return result.includes("State: ACTIVE");
          } catch {
            return false;
          }
        },
        30000
      );
      extensionFound = true;
      break;
    } catch {
      // Extension not found — try again
      console.log("  extension not found, retrying...");
    }
  }

  if (!extensionFound) throw new Error("Extension failed to load after two GDM restarts");

  sshExec(`gnome-extensions enable ${cfg.extensionUuid} 2>/dev/null || true`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  const extState = sshExec(`gnome-extensions show ${cfg.extensionUuid} 2>&1`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  if (extState.includes("State: ACTIVE")) {
    console.log("Extension loaded and active");
  } else {
    console.log("WARNING: Extension state:", extState.trim());
  }

  // Restart dotoold
  // Install dotool if not present (not in base image)
  const isGoldenDepsImage = cfg.projectRoot.includes('golden-gnome-deps') || false;
  if (!isGoldenDepsImage) {
    try {
      const dotoolCheck = sshExec("which dotool 2>/dev/null || echo missing", cfg.sshKey, cfg.sshPort, cfg.sshUser);
      if (dotoolCheck.includes("missing")) {
        console.log("  Installing dotool...");
        sshExec("sudo dnf copr enable -y smallcms/dotool 2>/dev/null && sudo dnf install -y dotool 2>/dev/null", cfg.sshKey, cfg.sshPort, cfg.sshUser);
      }
    } catch {
      // Continue — dotoold start may fail with clear error
    }
  }
  console.log("Restarting dotoold...");
  // Fix /dev/uinput permissions so dotoold (running as testuser) can access it
  try {
    sshExec("sudo chmod 660 /dev/uinput && sudo chown root:input /dev/uinput 2>/dev/null || true", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  } catch {
    // Best effort — may fail if udev rule already set permissions
  }
  execSync(`ssh ${sshOpts(cfg.sshKey, cfg.sshPort)} ${cfg.sshUser}@localhost "export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe; dotoold &>/tmp/dotoold.log &"`, { timeout: 10000 });
  await pollUntilFn(
    "dotool pipe",
    async () => {
      const output = shellExec("test -p /run/user/$(id -u)/dotool-pipe && echo ready", cfg.sshKey, cfg.sshPort, cfg.sshUser);
      return output.includes("ready");
    },
    10000
  );
}

export function deployPythonSource(cfg: DeployConfig): void {
  if (!existsSync(cfg.pythonSrc)) return;
  console.log("Deploying Python source...");
  sshExec("rm -rf ~/voice_to_text/src/voice_to_text && mkdir -p ~/voice_to_text/src/voice_to_text", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  rsyncToVm(cfg.pythonSrc, "~/voice_to_text/src/voice_to_text", cfg.sshKey, cfg.sshPort, cfg.sshUser);
}

export function deployTestAudio(cfg: DeployConfig): void {
  const testAudio = cfg.testAudioFile;
  if (!existsSync(testAudio)) return;
  console.log(`Deploying test audio: ${testAudio}`);
  scpToVm(testAudio, "/tmp/test-audio.wav", cfg.sshKey, cfg.sshPort, cfg.sshUser);
}

export async function startVoiceService(
  shell: ShellHelper,
  cfg: DeployConfig,
  pollUntilFn: typeof pollUntil,
  pollForCommandOutputFn: typeof pollForCommandOutput,
  skipDeps = false
): Promise<void> {
  if (skipDeps) {
    console.log("Skipping Python dependency installation (deps pre-installed)");
  } else {
    console.log("Installing Python dependencies...");
    // Install portaudio-devel for sounddevice (not in base image)
    try {
      const paCheck = sshExec("rpm -q portaudio-devel 2>/dev/null || echo missing", cfg.sshKey, cfg.sshPort, cfg.sshUser);
      if (paCheck.includes("missing")) {
        console.log("  Installing portaudio-devel...");
        sshExec("sudo dnf install -y portaudio-devel 2>/dev/null", cfg.sshKey, cfg.sshPort, cfg.sshUser);
      }
    } catch {
      // Continue — sounddevice install may fail with clear error
    }
    // Use uv for faster, more reliable installs (matches install.sh approach)
    const uvResult = shellExec(
      "$HOME/.local/bin/uv pip install --system --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz sounddevice groq onnxruntime 2>&1 && echo __UV_OK__ || echo __UV_FAILED__",
      cfg.sshKey, cfg.sshPort, cfg.sshUser
    );
    if (!uvResult.includes("__UV_OK__")) {
      // Fallback to pip if uv not available
      console.log("  uv install failed, falling back to pip...");
      // Use sshExec for pip (shell.exec has issues with long output)
      try {
        sshExec("python3 -m ensurepip --user 2>/dev/null || true", cfg.sshKey, cfg.sshPort, cfg.sshUser);
        sshExec(
          "python3 -m pip install --user --break-system-packages --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz sounddevice groq onnxruntime",
          cfg.sshKey, cfg.sshPort, cfg.sshUser
        );
        console.log("  pip install completed");
      } catch (e) {
        console.log("  FATAL: pip install failed:", (e as Error).message);
        throw new Error(`Dependency installation failed (uv and pip both failed): ${(e as Error).message}`);
      }
    }
  }

  // Kill existing voice service
  sshExec("killall -9 python3 2>/dev/null; true", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  await Bun.sleep(1000);
  await pollUntilFn(
    "old voice service to die",
    async () => {
      const output = shellExec("busctl --user list 2>/dev/null | grep com.happytomatoe.VoiceToText", cfg.sshKey, cfg.sshPort, cfg.sshUser);
      return output.trim().length === 0;
    },
    5000
  );
  await Bun.sleep(500);

  // Copy config and start service
  sshExec("mkdir -p ~/.config/voice-to-text", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  const configName = process.env.CI ? "voice-to-text-config.ci.yaml" : "voice-to-text-config.local.yaml";
  scpToVm(join(cfg.fixtureDir, configName), "~/.config/voice-to-text/config.yaml", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  
  // Set output method from config (default to 'type')
  const outputMethod = cfg.outputMethod || 'type';
  console.log(`  Using output method: ${outputMethod}`);
  
  shellExec(
    `export PATH=$HOME/.local/bin:$PATH; export XDG_RUNTIME_DIR=/run/user/$(id -u); export VOICE_TO_TEXT_PROVIDER=parakeet; export VOICE_TO_TEXT_DEBUG_FILE=/tmp/test-audio.wav; export VOICE_TO_TEXT_OUTPUT_METHOD=${outputMethod}; export PYTHONPATH=~/voice_to_text/src; cd ~; nohup python3 -m voice_to_text > /tmp/voice-service.log 2>&1 &`,
    cfg.sshKey, cfg.sshPort, cfg.sshUser
  );

  await pollForCommandOutputFn(
    (cmd: string) => Promise.resolve(shellExec(cmd, cfg.sshKey, cfg.sshPort, cfg.sshUser)),
    "busctl --user list 2>/dev/null | grep com.happytomatoe.VoiceToText",
    "com.happytomatoe.VoiceToText",
    15000
  );
}
