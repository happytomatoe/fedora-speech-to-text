import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ShellHelper } from "./shell.js";
import { Deployer } from "./deploy.js";
import { pollUntil, pollForProcess, pollForCommandOutput } from "./poll.js";

// --- SSH exec helpers (sync, for quick one-off commands) ---

function sshOpts(sshKey: string, sshPort: number): string {
  return `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${sshKey} -p ${sshPort}`;
}

export function sshExec(command: string, sshKey: string, sshPort: number, sshUser = "testuser", retries = 3): string {
  if (retries < 1) retries = 1;
  const host = `${sshUser}@localhost`;
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(`ssh ${sshOpts(sshKey, sshPort)} ${host} "${command}"`, { timeout: 30000 }).toString();
    } catch (err) {
      lastErr = err as Error;
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
  shellExec: (cmd: string) => Promise<string>
): Promise<void> {
  const t0 = Date.now();
  console.log("Waiting for GNOME Shell to register on D-Bus...");
  // Use gdbus wait to get shell on D-Bus quickly (~350ms)
  await shellExec("gdbus wait --session --timeout=60 org.gnome.Shell");
  console.log(`  gdbus wait: ${Date.now() - t0}ms [time]`);
  
  // Poll SessionIsActive — indicates full session is up.
  // The PTY shell is functional after gdbus wait returns.
  const t1 = Date.now();
  let ready = false;
  for (let i = 0; i < 20; i++) {
    const result = await shellExec(
      `busctl --user get-property org.gnome.SessionManager /org/gnome/SessionManager org.gnome.SessionManager SessionIsActive 2>&1 || true`
    );
    if (result.includes("b true")) {
      ready = true;
      break;
    }
    await Bun.sleep(100);
  }
  console.log(`  session ready: ${Date.now() - t1}ms [time]`);
  console.log(`  GDM login total: ${Date.now() - t0}ms [time]`);
  
  if (!ready) {
    console.log("WARNING: Session did not become ready in time, continuing anyway");
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
  console.log("Deploying GNOME extension directly (skipping install.sh prereqs)...");
  
  // Use /home/testuser explicitly — $HOME would expand on LOCAL shell in sshExec
  const homeDir = `/home/${cfg.sshUser}`;
  const installDir = `${homeDir}/.local/share/gnome-shell/extensions/${cfg.extensionUuid}`;

  // Upload extension files and install directly (skip install.sh which runs prereqs)
  const tUpload = Date.now();
  const installCmd = [
    `rm -rf "${installDir}"`,
    `mkdir -p "${installDir}/schemas"`,
    `mkdir -p "${installDir}/prefs"`,
    `mkdir -p "${installDir}/vendor"`,
  ].join(' && ');

  if (deployer) {
    await deployer.exec(installCmd);
    await deployer.uploadDir(extDir, installDir);
  } else {
    sshExec(installCmd, cfg.sshKey, cfg.sshPort, cfg.sshUser);
    rsyncToVm(extDir, installDir, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  }
  console.log(`    upload+install: ${Date.now() - tUpload}ms [time]`);

  // Compile schemas
  const tSetup = Date.now();
  if (deployer) {
    await deployer.exec(`glib-compile-schemas "${installDir}/schemas/"`);
  } else {
    sshExec(`glib-compile-schemas "${installDir}/schemas/"`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  }

  // Set dconf values
  await shell.exec(`dconf write /org/gnome/shell/enabled-extensions "['${cfg.extensionUuid}']"`);
  await shell.exec(`dconf write /org/gnome/shell/disable-user-extensions false`);
  await shell.exec(`cat > /tmp/dconf-set.sh << 'SCRIPT'
#!/bin/bash
dconf write /org/gnome/shell/extensions/voice-to-text/provider "'parakeet'"
dconf write /org/gnome/shell/extensions/voice-to-text/custom-words "['herdr', 'command', 'PR']"
SCRIPT
chmod +x /tmp/dconf-set.sh && bash /tmp/dconf-set.sh`);
  console.log(`    setup+dconf: ${Date.now() - tSetup}ms [time]`);
  console.log(`  deploy total: ${Date.now() - t0}ms [time]`);

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
          const result = await shell.exec(
            `test -S /run/user/$(id -u)/bus && echo ready`
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
      await shell.exec("gdbus wait --session --timeout=60 org.gnome.Shell");
    } catch {
      // gdbus wait may fail if shell is already up — check pgrep as fallback
      await pollForProcess(shell.exec.bind(shell), "gnome-shell --mode=user", 30000);
    }
    console.log(`  gnome-shell ready: ${Date.now() - t3}ms [time]`);

    // Poll for GNOME Shell extension system to be ready
    await pollUntilFn(
      "extension system ready",
      async () => {
        try {
          const listResult = await shell.exec(`gnome-extensions list 2>&1 || true`);
          return listResult.includes(cfg.extensionUuid);
        } catch {
          return false;
        }
      },
      30000
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
      const output = await shell.exec("test -p /run/user/$(id -u)/dotool-pipe && echo ready");
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
    const uvResult = await shell.exec(
      "$HOME/.local/bin/uv pip install --system --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz sounddevice groq onnxruntime 2>&1 && echo __UV_OK__ || echo __UV_FAILED__"
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
      const output = await shell.exec("busctl --user list 2>/dev/null | grep com.happytomatoe.VoiceToText");
      return output.trim().length === 0;
    },
    5000
  );
  await Bun.sleep(500);

  // Copy config and start service
  sshExec("mkdir -p ~/.config/voice-to-text", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  scpToVm(join(cfg.fixtureDir, "voice-to-text-config.yaml"), "~/.config/voice-to-text/config.yaml", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  
  // Set output method from config (default to 'type')
  const outputMethod = cfg.outputMethod || 'type';
  console.log(`  Using output method: ${outputMethod}`);
  
  await shell.exec(
    `export PATH=$HOME/.local/bin:$PATH; export XDG_RUNTIME_DIR=/run/user/$(id -u); export VOICE_TO_TEXT_PROVIDER=parakeet; export VOICE_TO_TEXT_DEBUG_FILE=/tmp/test-audio.wav; export VOICE_TO_TEXT_OUTPUT_METHOD=${outputMethod}; export PYTHONPATH=~/voice_to_text/src; cd ~; nohup python3 -m voice_to_text > /tmp/voice-service.log 2>&1 &`
  );

  await pollForCommandOutputFn(
    shell.exec.bind(shell),
    "busctl --user list 2>/dev/null | grep com.happytomatoe.VoiceToText",
    "com.happytomatoe.VoiceToText",
    15000
  );
}
