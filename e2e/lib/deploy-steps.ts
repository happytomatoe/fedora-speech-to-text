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
  outputMethod?: string; // Output method to test: type, clipboard, mutter-virtual
}

// --- Deployment steps ---

export async function waitForGdmLogin(
  shellExec: (cmd: string) => Promise<string>
): Promise<void> {
  const t0 = Date.now();
  console.log("Waiting for GNOME Shell to register on D-Bus...");
  // Use gdbus wait to get shell on D-Bus quickly
  await shellExec("gdbus wait --session --timeout=60 org.gnome.Shell");
  console.log(`  gdbus wait: ${Date.now() - t0}ms`);
  
  // Poll until SessionManager is ready (indicates full session is up)
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
  console.log(`  session ready: ${Date.now() - t1}ms`);
  
  if (ready) {
    // Verify session is actually ready for commands
    try {
      const testResult = await shellExec("echo ok");
      if (testResult.trim() !== "ok") {
        console.log("  WARNING: Session test command failed");
      }
    } catch (e) {
      console.log("  WARNING: Session test command failed:", e);
    }
  }
  console.log(`  GDM login total: ${Date.now() - t0}ms`);
  
  if (!ready) {
    console.log("WARNING: Session did not become ready in time, continuing anyway");
  }
}

export async function installDependencies(
  sshKey: string,
  sshPort: number,
  sshUser: string
): Promise<void> {
  const t0 = Date.now();
  console.log("Installing dependencies...");
  // Install tmux if not present (needed for terminal session management in tests)
  const t = Date.now();
  sshExec("command -v tmux >/dev/null 2>&1 || sudo dnf install -y tmux", sshKey, sshPort, sshUser);
  console.log(`  tmux: ${Date.now() - t}ms`);
  // Install uv if not present (faster Python dependency installation)
  const t2 = Date.now();
  sshExec("command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh", sshKey, sshPort, sshUser);
  console.log(`  uv: ${Date.now() - t2}ms`);
  console.log(`  dependencies total: ${Date.now() - t0}ms`);
}

// extractDbusAddress removed — callers use getShellDbusAddr() in shell.ts instead

export async function deployExtension(
  shell: ShellHelper,
  cfg: DeployConfig,
  pollUntilFn: typeof pollUntil
): Promise<void> {
  const extDir = join(cfg.projectRoot, "gnome-ext");
  if (!existsSync(extDir)) return;

  const t0 = Date.now();
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
  console.log(`  rsync+dconf: ${Date.now() - t0}ms`);

  // Try to load extension dynamically via D-Bus (faster than GDM restart)
  // Falls back to GDM restart if D-Bus method not available
  console.log("Loading extension via D-Bus...");
  const t1 = Date.now();
  let extensionLoaded = false;
  
  try {
    // Try D-Bus method to load extension
    const dbusResult = await shell.exec(
      `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval \
        "Main.extensionManager.loadExtension '${cfg.extensionUuid}'" 2>&1 || true`
    );
    
    if (dbusResult.includes("true") || dbusResult.includes("(true, '')")) {
      console.log("Extension loaded via D-Bus");
      // Verify the extension is actually available
      try {
        const verifyResult = sshExec(`gnome-extensions show ${cfg.extensionUuid} 2>&1`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
        if (!verifyResult.includes("doesn't exist")) {
          extensionLoaded = true;
        } else {
          console.log("  D-Bus load succeeded but extension not found, will use GDM restart");
        }
      } catch {
        // Extension not recognized, fall back to GDM restart
      }
    }
  } catch {
    // D-Bus method not available, will try GDM restart
  }
  console.log(`  D-Bus attempt: ${Date.now() - t1}ms`);
  
  // Fall back to GDM restart if D-Bus loading failed
  if (!extensionLoaded) {
    console.log("D-Bus loading failed, restarting GNOME Shell via reexec...");
    
    // Try global.reexec_self() first (faster than GDM restart)
    let extensionFound = false;
    try {
      await shell.exec(
        `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
          --method org.gnome.Shell.Eval \
          'global.reexec_self()' 2>&1 || true`
      );
      
      // Wait for GNOME Shell to restart
      await Bun.sleep(5000);
      
      // Re-establish SSH session (shell may have dropped)
      await shell.close();
      await shell.openSshSession({ sshKey: cfg.sshKey, sshPort: cfg.sshPort, sshUser: cfg.sshUser });
      
      // Wait for GNOME Shell to be ready
      await pollForProcess(shell.exec.bind(shell), "gnome-shell --mode=user", 30000);
      await Bun.sleep(3000);
      
      // Check if extension is now available
      const verifyResult = sshExec(`gnome-extensions show ${cfg.extensionUuid} 2>&1`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
      if (!verifyResult.includes("doesn't exist")) {
        extensionFound = true;
        console.log("Extension loaded via reexec");
      }
    } catch {
      // reexec failed, will try GDM restart
    }
    
    // Fall back to GDM restart if reexec didn't work
    if (!extensionFound) {
      console.log("reexec failed, restarting GDM...");
      
      // Restart GDM to load the extension (with retry)
      // Use sshExec (not shell.exec) because shell.exec uses a PTY that hangs
      // when GDM restart drops the SSH connection.
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
        const t2 = Date.now();
        await pollForProcess(shell.exec.bind(shell), "gnome-shell --mode=user", 30000);

        // Give GNOME Shell time to initialize extension system
        await Bun.sleep(3000);
        console.log(`  GDM restart+SSH: ${Date.now() - t2}ms`);

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
    }

    if (!extensionFound) throw new Error("Extension failed to load after two GDM restarts");
  }

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
