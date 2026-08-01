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

export async function extractDbusAddress(
  shell: ShellHelper
): Promise<void> {
  await shell.exec(
    `DBUS_ADDR=$(cat /proc/$(pgrep -f 'gnome-shell --mode=user' | head -1)/environ 2>/dev/null | tr '\\0' '\\n' | grep DBUS_SESSION_BUS_ADDRESS | head -1 | cut -d= -f2-); if [ -n "$DBUS_ADDR" ]; then echo "$DBUS_ADDR" > /tmp/dbus-address; fi`
  );
}

export async function deployExtension(
  shell: ShellHelper,
  cfg: DeployConfig,
  pollUntilFn: typeof pollUntil
): Promise<void> {
  const extDir = join(cfg.projectRoot, "gnome-ext");
  if (!existsSync(extDir)) return;

  console.log("Deploying GNOME extension...");
  rsyncToVm(extDir, `~/.local/share/gnome-shell/extensions/${cfg.extensionUuid}`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  await shell.exec(`glib-compile-schemas ~/.local/share/gnome-shell/extensions/${cfg.extensionUuid}/schemas/ 2>/dev/null || true`);
  await shell.exec(`dconf write /org/gnome/shell/enabled-extensions "['${cfg.extensionUuid}']"`);
  await shell.exec(`dconf write /org/gnome/shell/disable-user-extensions false`);
  await shell.exec(`cat > /tmp/dconf-set.sh << 'SCRIPT'
#!/bin/bash
dconf write /org/gnome/shell/extensions/voice-to-text/provider "'parakeet'"
SCRIPT
chmod +x /tmp/dconf-set.sh && bash /tmp/dconf-set.sh`);

  // Restart GNOME Shell to load extension
  console.log("Restarting GNOME Shell to load extension...");
  await shell.exec("sudo systemctl restart gdm");

  // Re-establish SSH session after GDM restart
  console.log("Re-establishing SSH session after GDM restart...");
  await shell.close();
  await shell.openSshSession({ sshKey: cfg.sshKey, sshPort: cfg.sshPort, sshUser: cfg.sshUser });

  // Wait for GNOME Shell
  await pollForProcess(shell.exec.bind(shell), "gnome-shell --mode=user", 30000);

  // Wait for extension to be available
  console.log("Waiting for extension to be available...");
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

  sshExec(`gnome-extensions enable ${cfg.extensionUuid} 2>/dev/null || true`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  const extState = sshExec(`gnome-extensions show ${cfg.extensionUuid} 2>&1`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  if (extState.includes("State: ACTIVE")) {
    console.log("Extension loaded and active");
  } else {
    console.log("WARNING: Extension state:", extState.trim());
  }

  // Restart dotoold
  console.log("Restarting dotoold...");
  sshExec("export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe; /home/testuser/.local/bin/dotoold &>/tmp/dotoold.log &", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  await pollUntilFn(
    "dotool pipe",
    async () => {
      const output = await shell.exec("test -p /run/user/$(id -u)/dotool-pipe");
      return output.length === 0;
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
  await shell.exec(
    "pip3 install --user --break-system-packages --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz 2>/dev/null || true"
  );

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
