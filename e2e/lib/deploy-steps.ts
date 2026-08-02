import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ShellHelper } from "./shell.js";
import { pollUntil, pollForProcess, pollForCommandOutput } from "./poll.js";

// --- SSH exec helpers (sync, for quick one-off commands) ---

function sshOpts(sshKey: string, sshPort: number): string {
  return `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${sshKey} -p ${sshPort}`;
}

export function sshExec(command: string, sshKey: string, sshPort: number, sshUser = "testuser"): string {
  const host = `${sshUser}@localhost`;
  return execSync(`ssh ${sshOpts(sshKey, sshPort)} ${host} "${command}"`).toString();
}

export function rsyncToVm(src: string, dest: string, sshKey: string, sshPort: number, sshUser = "testuser"): void {
  const host = `${sshUser}@localhost`;
  execSync(`rsync -az --delete -e "ssh ${sshOpts(sshKey, sshPort)}" ${src}/ ${host}:${dest}/`, { stdio: "pipe" });
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
}

// --- Deployment steps ---

export async function waitForGdmLogin(
  shellExec: (cmd: string) => Promise<string>
): Promise<void> {
  console.log("Waiting for GDM auto-login...");
  await pollForCommandOutput(shellExec, "loginctl list-sessions", "seat0", 60000);
}

export async function installDependencies(
  sshKey: string,
  sshPort: number,
  sshUser: string
): Promise<void> {
  console.log("Installing dependencies...");
  // Install tmux if not present (needed for terminal session management in tests)
  sshExec("command -v tmux >/dev/null 2>&1 || sudo dnf install -y tmux", sshKey, sshPort, sshUser);
  // Install uv if not present (faster Python dependency installation)
  sshExec("command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh", sshKey, sshPort, sshUser);
}

// extractDbusAddress removed — callers use getShellDbusAddr() in shell.ts instead

export async function deployExtension(
  shell: ShellHelper,
  cfg: DeployConfig,
  pollUntilFn: typeof pollUntil
): Promise<void> {
  const extDir = join(cfg.projectRoot, "gnome-ext");
  if (!existsSync(extDir)) return;

  console.log("Deploying GNOME extension...");
  rsyncToVm(extDir, `~/.local/share/gnome-shell/extensions/${cfg.extensionUuid}`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  sshExec(`glib-compile-schemas ~/.local/share/gnome-shell/extensions/${cfg.extensionUuid}/schemas/`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  await shell.exec(`dconf write /org/gnome/shell/enabled-extensions "['${cfg.extensionUuid}']"`);
  await shell.exec(`dconf write /org/gnome/shell/disable-user-extensions false`);
  await shell.exec(`cat > /tmp/dconf-set.sh << 'SCRIPT'
#!/bin/bash
dconf write /org/gnome/shell/extensions/voice-to-text/provider "'parakeet'"
SCRIPT
chmod +x /tmp/dconf-set.sh && bash /tmp/dconf-set.sh`);

  // Restart GDM to load the extension (with retry)
  // Use sshExec (not shell.exec) because shell.exec uses a PTY that hangs
  // when GDM restart drops the SSH connection.
  let extensionFound = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    console.log(`Restarting GDM to load extension (attempt ${attempt + 1})...`);
    try {
      sshExec("sudo systemctl restart gdm", cfg.sshKey, cfg.sshPort, cfg.sshUser);
    } catch {
      // Expected: GDM restart drops the SSH connection mid-command
    }

    // Wait for GDM to fully restart and create a new user session
    console.log("Waiting for GDM to stabilize...");
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
    console.log("Re-establishing SSH session after GDM restart...");
    await shell.close();
    await shell.openSshSession({ sshKey: cfg.sshKey, sshPort: cfg.sshPort, sshUser: cfg.sshUser });

    // Wait for GNOME Shell
    await pollForProcess(shell.exec.bind(shell), "gnome-shell --mode=user", 30000);

    // Give GNOME Shell time to initialize extension system
    await Bun.sleep(3000);

    // Wait for extension to be available
    console.log("Waiting for extension to be available...");
    try {
      await pollUntilFn(
        "extension available",
        async () => {
          try {
            const result = sshExec(`gnome-extensions show ${cfg.extensionUuid} 2>&1`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
            return !result.includes("doesn't exist");
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
      console.log("Extension not found, retrying...");
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
  console.log("Restarting dotoold...");
  execSync(`ssh ${sshOpts(cfg.sshKey, cfg.sshPort)} ${cfg.sshUser}@localhost "export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe; /home/testuser/.local/bin/dotoold &>/tmp/dotoold.log &"`, { timeout: 10000 });
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
  sshExec("mkdir -p ~/voice_to_text/src/voice_to_text", cfg.sshKey, cfg.sshPort, cfg.sshUser);
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
  pollForCommandOutputFn: typeof pollForCommandOutput
): Promise<void> {
  console.log("Installing Python dependencies...");
  // Use uv for faster, more reliable installs (matches install.sh approach)
  const uvResult = await shell.exec(
    "$HOME/.local/bin/uv pip install --system --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz 2>&1 || true"
  );
  if (uvResult.includes("ERROR") || uvResult.includes("Failed")) {
    // Fallback to pip if uv not available
    console.log("  uv not available, falling back to pip...");
    const pipResult = await shell.exec(
      "pip3 install --user --break-system-packages --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz 2>&1 || true"
    );
    if (pipResult.includes("ERROR") || pipResult.includes("Failed")) {
      console.log("  WARNING: pip install issues:", pipResult.trim());
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
  await shell.exec(
    `export PATH=$HOME/.local/bin:$PATH; export XDG_RUNTIME_DIR=/run/user/$(id -u); export VOICE_TO_TEXT_PROVIDER=parakeet; export VOICE_TO_TEXT_DEBUG_FILE=/tmp/test-audio.wav; export PYTHONPATH=~/voice_to_text/src; cd ~; nohup python3 -m voice_to_text > /tmp/voice-service.log 2>&1 &`
  );

  await pollForCommandOutputFn(
    shell.exec.bind(shell),
    "busctl --user list 2>/dev/null | grep com.happytomatoe.VoiceToText",
    "com.happytomatoe.VoiceToText",
    15000
  );
}
