import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ShellHelper } from "./shell.js";
import { Deployer } from "./deploy.js";
import { pollUntil, pollForProcess, pollForCommandOutput } from "./poll.js";
import type { SuiteEnv } from "./env.js";

// --- SSH exec helpers (sync, for quick one-off commands) ---

/** Common ssh options: no host-key prompts, no log noise. */
function sshOpts(sshKey: string, sshPort: number): string {
  return `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${sshKey} -p ${sshPort}`;
}

/** One-shot ssh exec with retries; throws after the last attempt fails. */
function sshExec(command: string, sshKey: string, sshPort: number, sshUser = "testuser", retries = 3): string {
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

/** Async sshExec variant for use inside async poll loops. */
export async function sshExecAsync(command: string, sshKey: string, sshPort: number, sshUser = "testuser"): Promise<string> {
  try {
    return sshExec(command, sshKey, sshPort, sshUser);
  } catch {
    return ""; // Poll callers treat empty output as "not ready yet"
  }
}

/** Rsync a directory into the VM (exact mirror, deletes extras). */
function rsyncToVm(src: string, dest: string, sshKey: string, sshPort: number, sshUser = "testuser"): void {
  const host = `${sshUser}@localhost`;
  execSync(`rsync -azc --delete --delete-excluded -e "ssh ${sshOpts(sshKey, sshPort)}" ${src}/ ${host}:${dest}/`, { stdio: "pipe" });
}

/** Copy a single file into the VM. */
function scpToVm(src: string, dest: string, sshKey: string, sshPort: number, sshUser = "testuser"): void {
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
  /** Environment abstraction — OS/package-manager specifics live here. */
  env: SuiteEnv;
}

// --- Deployment steps ---

// Max wait for GDM/GNOME Shell to register on the session bus after boot/restart
const GDM_READY_TIMEOUT_MS = 240_000;

// Ensure GDM auto-login is configured before waiting for a session.
// The base image ships gdm enabled in greeter mode; on a fresh boot the
// greeter crash-loops (glib int3 traps) and no user session ever appears,
// so waitForGdmLogin would burn its full timeout. Writing custom.conf and
// restarting GDM here gets autologin running before we poll.
/** Write custom.conf for autologin and restart GDM before we poll.
 * Ubuntu keeps GDM config at /etc/gdm3/custom.conf (Debian layout, unlike
 * Fedora's /etc/gdm/custom.conf). */
export async function ensureGdmAutologin(deployer: Deployer, sshUser: string, env: SuiteEnv): Promise<void> {
  const gdmConf = `[daemon]\nAutomaticLoginEnable=True\nAutomaticLogin=${sshUser}\nWaylandEnable=true\n\n[security]\n\n[debug]\n`;
  const gdmConfPath = env.gdmConfPath;
  try {
    const current = await deployer.exec(`cat ${gdmConfPath} 2>/dev/null || true`);
    // WaylandEnable=true is required too: gdm 48 on Fedora 42 dropped X11
    // support, and with WaylandEnable=false it finds no X11 session desktop
    // files and SIGTRAPs in get_fallback_session_name (crash-loop).
    if (current.stdout.includes(`AutomaticLogin=${sshUser}`) && !current.stdout.includes("WaylandEnable=false")) return;
    await deployer.exec(`echo '${gdmConf}' | sudo tee ${gdmConfPath} > /dev/null`);
    try {
      await deployer.exec("sudo systemctl restart gdm");
    } catch {
      // Expected: GDM restart may drop the connection mid-command
    }
    // Wait for GDM to come back up
    for (let i = 0; i < 30; i++) {
      const r = await deployer.exec("systemctl is-active gdm 2>/dev/null || true");
      if (r.stdout.trim() === "active") return;
      await Bun.sleep(1000);
    }
  } catch (e) {
    console.error(`  ensureGdmAutologin failed (continuing): ${e}`);
  }
}

/** Wait until the GDM auto-login session reaches a login prompt state. */
export async function waitForGdmLogin(deployer: Deployer): Promise<void> {
  const t0 = Date.now();
  console.log("Waiting for GNOME Shell to register on D-Bus...");
  // Poll for org.gnome.Shell on the session bus over plain SSH. A
  // slow/contended VT can't trip a "prompt visible" text-match, and polling
  // (rather than a single blocking `gdbus wait`) gives visible progress and a
  // hard cap so a slow boot can't look like an indefinite hang under host
  // contention.
  // Force the session-bus address: a non-interactive SSH session may lack the
  // session env, so gdbus --session wouldn't see the bus the GDM graphical
  // session registers gnome-shell on. Fall back to pgrep (bus-independent).
  const deadline = t0 + GDM_READY_TIMEOUT_MS;
  let ready = false;
  let i = 0;
  let lastOut = "";
  while (Date.now() < deadline) {
    const { stdout } = await deployer.exec(
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell 2>&1 || true"
    );
    lastOut = stdout;
    if (stdout.includes("org.gnome.Shell")) {
      ready = true;
      break;
    }
    const pgrep = await deployer.exec("pgrep -x gnome-shell >/dev/null 2>&1 && echo up || true");
    if (pgrep.stdout.includes("up")) {
      ready = true;
      break;
    }
    i++;
    if (i % 10 === 0) {
      console.log(`  still waiting for GNOME Shell… (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
    await Bun.sleep(1000);
  }
  console.log(`  GDM login total: ${Date.now() - t0}ms [time]`);
  if (!ready) {
    console.error(`  last gdbus output: ${lastOut.slice(0, 200)}`);
    throw new Error("GNOME Shell did not register on the session bus in time");
  }
}

/** Install VM-side test dependencies (packages, tools) via SSH. */
export async function installDependencies(
  env: SuiteEnv,
  _sshKey: string,
  _sshPort: number,
  _sshUser: string
): Promise<void> {
  const t0 = Date.now();

  // Install GDM + GNOME Shell if not present (base cloud image is headless)
  try {
    const gdmCheck = sshExec(env.pkgIsInstalled("gnome-shell"), _sshKey, _sshPort, _sshUser);
    if (gdmCheck.includes("missing")) {
      console.log("  Installing GDM + GNOME Shell...");
      sshExec(env.pkgInstall("gdm gnome-shell gnome-session"), _sshKey, _sshPort, _sshUser);
    }
  } catch {
    // Continue — GDM install may fail on some images
  }

  if (env.os === "ubuntu") {
    // ghostty + tmux (ghostty is the terminal used in E2E; apt has a ghostty
    // package on Ubuntu 26.04)
    try {
      const termCheck = sshExec("which ghostty tmux 2>/dev/null | wc -l", _sshKey, _sshPort, _sshUser);
      if (!termCheck.includes("2")) {
        console.log("  Installing ghostty + tmux...");
        sshExec(env.pkgInstall("ghostty tmux") + " || " + env.pkgInstall("tmux"), _sshKey, _sshPort, _sshUser);
      }
    } catch {
      // Continue — tmux may work without a terminal emulator depending on flow
    }
    // dotool: no Ubuntu apt package — bundled prebuilt binaries
    // (built from git.sr.ht/~geb/dotool v1.6)
    try {
      const dotoolCheck = sshExec("which dotool 2>/dev/null || echo missing", _sshKey, _sshPort, _sshUser);
      if (dotoolCheck.includes("missing") && env.dotool.kind === "bundled") {
        console.log("  Installing dotool (bundled binaries)...");
        for (const bin of ["dotool", "dotoolc", "dotoold"]) {
          scpToVm(join(env.dotool.dir, "bin", bin), `/tmp/${bin}`, _sshKey, _sshPort, _sshUser);
        }
        sshExec("sudo install -m755 /tmp/dotool /tmp/dotoolc /tmp/dotoold /usr/local/bin/ && rm -f /tmp/dotool /tmp/dotoolc /tmp/dotoold", _sshKey, _sshPort, _sshUser);
      }
    } catch {
      // Continue — dotoold start may fail with clear error
    }
    // uv (Python package manager, used to run the voice service)
    try {
      const uvCheck = sshExec("which uv 2>/dev/null || echo missing", _sshKey, _sshPort, _sshUser);
      if (uvCheck.includes("missing")) {
        console.log("  Installing uv...");
        sshExec("curl -LsSf https://astral.sh/uv/install.sh | sh > /tmp/uv-install.log 2>&1", _sshKey, _sshPort, _sshUser);
      }
    } catch {
      // Continue — service start will surface a clear error if uv is missing
    }
    console.log(`  dependencies total: ${Date.now() - t0}ms [time]`);
    return;
  }

  // --- Fedora path ---

  // Install gnome-terminal if not present (needed for tmux in E2E tests)
  try {
    const termCheck = sshExec("which gnome-terminal 2>/dev/null || echo missing", _sshKey, _sshPort, _sshUser);
    if (termCheck.includes("missing")) {
      console.log("  Installing gnome-terminal...");
      sshExec(env.pkgInstall("gnome-terminal"), _sshKey, _sshPort, _sshUser);
    }
  } catch {
    // Continue — tmux may work without it depending on test flow
  }
  // Install Ghostty via COPR (for testing mutter-paste clipboard behavior)
  try {
    const ghosttyCheck = sshExec("which ghostty 2>/dev/null || echo missing", _sshKey, _sshPort, _sshUser);
    if (ghosttyCheck.includes("missing")) {
      console.log("  Installing Ghostty via COPR...");
      sshExec("sudo dnf copr enable -y scottames/ghostty 2>/dev/null && " + env.pkgInstall("ghostty"), _sshKey, _sshPort, _sshUser);
    }
  } catch {
    // Continue — Ghostty install may fail, fall back to gnome-terminal
  }
  console.log(`  dependencies total: ${Date.now() - t0}ms [time]`);
}

// extractDbusAddress removed — callers use getShellDbusAddr() in shell.ts instead

/** Upload gnome-ext/ + install.sh to the VM and install the extension. */
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
    // Upload service/ too so install.sh --local uses local copies instead of
    // curling github (the VM may have no/slow network under contention).
    await deployer.uploadDir(join(cfg.projectRoot, 'service'), '~/tmp-deploy/service');
  } else {
    sshExec(`mkdir -p ~/tmp-deploy`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
    rsyncToVm(join(cfg.projectRoot, 'install.sh'), '~/tmp-deploy/install.sh', cfg.sshKey, cfg.sshPort, cfg.sshUser);
    rsyncToVm(extDir, '~/tmp-deploy/gnome-ext', cfg.sshKey, cfg.sshPort, cfg.sshUser);
    rsyncToVm(join(cfg.projectRoot, 'service'), '~/tmp-deploy/service', cfg.sshKey, cfg.sshPort, cfg.sshUser);
  }
  console.log(`    upload: ${Date.now() - tUpload}ms [time]`);
  
  const tInstall = Date.now();
  if (deployer) {
    // gnome-extensions needs the session bus, which a non-interactive SSH
    // exec may lack — set it explicitly so install.sh --local doesn't stall.
    // --e2e makes install.sh install only the extension (skip sudo/dnf/uv/git
    // network steps that hang a headless SSH session); golden image provides the rest.
    await deployer.exec('export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus; chmod +x ~/tmp-deploy/install.sh && bash ~/tmp-deploy/install.sh --e2e --local ~/tmp-deploy/gnome-ext');
  } else {
    sshExec(`chmod +x ~/tmp-deploy/install.sh && bash ~/tmp-deploy/install.sh --e2e --local ~/tmp-deploy/gnome-ext`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  }
  console.log(`    install.sh: ${Date.now() - tInstall}ms [time]`);
  
  const tDconf = Date.now();
  await shell.exec(`dconf write /org/gnome/shell/enabled-extensions "['${cfg.extensionUuid}']"`);
  await shell.exec(`dconf write /org/gnome/shell/disable-user-extensions false`);
  await shell.exec(`cat > /tmp/dconf-set.sh << 'SCRIPT'
#!/bin/bash
dconf write /org/gnome/shell/extensions/voice-to-text/provider "'parakeet'"
dconf write /org/gnome/shell/extensions/voice-to-text/custom-words "['herdr', 'command', 'PR']"
dconf write /org/gnome/shell/extensions/voice-to-text/show-audio-level-widget "true"
dconf write /org/gnome/shell/extensions/voice-to-text/inhibit-sleep "true"
dconf write /org/gnome/shell/extensions/voice-to-text/stop-timeout-seconds "120"
# GTK apps expose their widget tree on the a11y bus only when this is on
# (and only at app startup — must be set before prefs launches)
dconf write /org/gnome/desktop/interface/toolkit-accessibility "true"
SCRIPT
chmod +x /tmp/dconf-set.sh && bash /tmp/dconf-set.sh`);
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
    sshExec(`echo '${gdmConf}' | sudo tee ${cfg.env.gdmConfPath} > /dev/null`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  } catch {
    // May fail if already configured — continue
  }
  
  // Install dotool concurrently with the GDM restart loop: it uses one-shot
  // sshExec connections that survive a GDM restart, unlike the persistent
  // shell session. The dotoold *start* below must stay after (needs the
  // recreated user session for XDG_RUNTIME_DIR).
  const isGoldenDepsImage = cfg.projectRoot.includes('golden-gnome-deps') || false;
  const dotoolInstallPromise: Promise<void> = (async () => {
    if (isGoldenDepsImage) return;
    try {
      const dotoolCheck = sshExec("which dotool 2>/dev/null || echo missing", cfg.sshKey, cfg.sshPort, cfg.sshUser);
      if (dotoolCheck.includes("missing")) {
        console.log("  Installing dotool...");
        sshExec("sudo dnf copr enable -y smallcms/dotool 2>/dev/null && sudo dnf install -y dotool 2>/dev/null", cfg.sshKey, cfg.sshPort, cfg.sshUser);
      }
    } catch (err) {
      // Continue — dotoold start may fail with clear error
      console.error("dotool install check failed:", err instanceof Error ? err.message : err);
    }
  })();

  let extensionFound = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    console.log(`  attempt ${attempt + 1}...`);
    try {
      sshExec("sudo systemctl restart gdm", cfg.sshKey, cfg.sshPort, cfg.sshUser);
    } catch {
      // Expected: GDM restart drops the SSH connection mid-command
    }

    // Wait for GDM to restart. Best-effort: if restart-command output has
    // flushed and SSH answered once, teardown has begun. The real readiness
    // gates are the polls below (GDM active -> user session -> gnome-shell ->
    // extension ACTIVE). No fixed sleep needed.
    console.log("  waiting for GDM to stabilize...");

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
          const result = await shell.exec(`gnome-extensions list 2>&1`);
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

  if (!extensionFound) {
    // Surface why the extension never reached ACTIVE so the failure is
    // diagnosable instead of a bare "failed after two GDM restarts".
    console.log("\n[deploy] Extension failed to load. Dumping diagnostics:");
    const dump = (label: string, cmd: string) => {
      try {
        const out = sshExec(cmd, cfg.sshKey, cfg.sshPort, cfg.sshUser);
        console.log(`--- ${label} ---\n` + out.trim().split("\n").map((l) => "  " + l).join("\n"));
      } catch (e) {
        console.log(`--- ${label} --- (failed: ${(e as Error).message})`);
      }
    };
    dump("gnome-extensions list", "gnome-extensions list 2>&1");
    dump(`gnome-extensions show ${cfg.extensionUuid}`, `gnome-extensions show ${cfg.extensionUuid} 2>&1`);
    dump("dconf enabled-extensions", "dconf read /org/gnome/shell/enabled-extensions 2>&1; dconf read /org/gnome/shell/disable-user-extensions 2>&1");
    dump("install dir", `ls -la $HOME/.local/share/gnome-shell/extensions/${cfg.extensionUuid}/ 2>&1; echo '--- schemas ---'; ls $HOME/.local/share/gnome-shell/extensions/${cfg.extensionUuid}/schemas/ 2>&1`);
    dump("journalctl extension errors", "journalctl -b 2>&1 | grep -i 'voice-to-text' | tail -25");
    throw new Error("Extension failed to load after two GDM restarts");
  }

  sshExec(`gnome-extensions enable ${cfg.extensionUuid} 2>/dev/null || true`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  const extState = sshExec(`gnome-extensions show ${cfg.extensionUuid} 2>&1`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
  if (extState.includes("State: ACTIVE")) {
    console.log("Extension loaded and active");
  } else {
    console.log("WARNING: Extension state:", extState.trim());
  }

  // Restart dotoold (dotool install ran in parallel with the GDM restart loop)
  await dotoolInstallPromise;
  // Fix /dev/uinput permissions so dotoold (running as testuser) can access it
  try {
    await shell.exec("sudo chmod 660 /dev/uinput && sudo chown root:input /dev/uinput 2>/dev/null || true");
  } catch {
    // Best effort — may fail if udev rule already set permissions
  }
  // Kill existing dotoold and remove stale pipe before starting fresh.
  // Kill by process NAME, not -f: pkill -f matches this very bash's own
  // cmdline (the pattern text is in its argv) and SIGKILLs the session.
  try {
    await shell.exec("pkill -f dotoold; rm -f /run/user/$(id -u)/dotool-pipe; sleep 0.5");
  } catch {
    // Ignore — may not be running
  }
  await shell.exec("export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe; nohup dotoold &>/tmp/dotoold.log &", 10000).catch(() => {});
  await pollUntilFn(
    "dotool pipe",
    async () => {
      try {
        const output = await shell.exec("test -p /run/user/$(id -u)/dotool-pipe && echo ready");
        return output.includes("ready");
      } catch {
        return false; // ssh hiccup — retry
      }
    },
    10000
  );
}

/** Sync Python source into the VM. */
export function deployPythonSource(cfg: DeployConfig): void {
  if (!existsSync(cfg.pythonSrc)) return;
  console.log("Deploying Python source...");
  sshExec("rm -rf ~/voice_to_text/src/voice_to_text && mkdir -p ~/voice_to_text/src/voice_to_text", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  rsyncToVm(cfg.pythonSrc, "~/voice_to_text/src/voice_to_text", cfg.sshKey, cfg.sshPort, cfg.sshUser);
}

/** Copy the current run's audio fixture into the VM. */
export function deployTestAudio(cfg: DeployConfig): void {
  const testAudio = cfg.testAudioFile;
  if (!existsSync(testAudio)) return;
  console.log(`Deploying test audio: ${testAudio}`);
  scpToVm(testAudio, "/tmp/test-audio.wav", cfg.sshKey, cfg.sshPort, cfg.sshUser);
}

/** Launch the voice-to-text service in the VM and wait until it's ready. */
export async function startVoiceService(
  shell: ShellHelper,
  cfg: DeployConfig,
  pollUntilFn: typeof pollUntil,
  pollForCommandOutputFn: typeof pollForCommandOutput,
  skipDeps = false
): Promise<void> {
  // Always ensure Python deps are present. The golden image may be
  // missing some (e.g. onnxruntime), and a fresh uv install is cheap and
  // idempotent — so we don't depend on the image being perfectly provisioned.
  // Skip when skipDeps (golden image has deps pre-installed).
  if (skipDeps) {
    console.log("  Skipping Python deps install (golden image)");
  } else {
  console.log("Installing Python dependencies...");
  // Fedora 43+ and Ubuntu 26.04 both mark the system interpreter
  // externally-managed (PEP 668) — --break-system-packages is required on
  // both. Ubuntu additionally needs sudo (root-owned dist-packages).
  const uvPrefix = cfg.env.uvSystemInstall ? "sudo " : "";
  const uvResult = await shell.exec(
    `${uvPrefix}$HOME/.local/bin/uv pip install --system --break-system-packages --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz sounddevice groq onnxruntime 2>/dev/null && echo __UV_OK__ || echo __UV_FAILED__`
  );
  if (!uvResult.includes("__UV_OK__")) {
    // Fallback to pip if uv not available / network constrained
    console.log("  uv install failed, falling back to pip...");
    try {
      sshExec("python3 -m ensurepip --user 2>/dev/null || true", cfg.sshKey, cfg.sshPort, cfg.sshUser);
      sshExec(
        "python3 -m pip install --user --break-system-packages --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz sounddevice groq onnxruntime 2>/dev/null || sudo $HOME/.local/bin/uv pip install --system --break-system-packages --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz sounddevice groq onnxruntime",
        cfg.sshKey, cfg.sshPort, cfg.sshUser
      );
      console.log("  pip install completed");
    } catch (e) {
      console.log("  FATAL: pip install failed:", (e as Error).message);
      throw new Error(`Dependency installation failed (uv and pip both failed): ${(e as Error).message}`);
    }
  }
  }

  // portaudio (for sounddevice) is provided by the Fedora golden image; only
  // install it when we're not relying on that pre-provisioned image.
  if (!skipDeps) {
    try {
      const paPkg = cfg.env.os === "ubuntu" ? "portaudio19-dev" : "portaudio-devel";
      const paCheck = sshExec(cfg.env.pkgIsInstalled(paPkg), cfg.sshKey, cfg.sshPort, cfg.sshUser);
      if (paCheck.includes("missing")) {
        console.log(`  Installing ${paPkg}...`);
        sshExec(cfg.env.pkgInstall(paPkg), cfg.sshKey, cfg.sshPort, cfg.sshUser);
      }
    } catch {
      // Continue — sounddevice import failure will surface at service start
    }
  }

  // Kill existing voice service (systemd user service + any python3 processes)
  sshExec("systemctl --user stop com.happytomatoe.VoiceToText.user.service 2>/dev/null; killall -9 python3 2>/dev/null; true", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  await Bun.sleep(1000);
  await pollUntilFn(
    "old voice service to die",
    async () => {
      try {
        const output = await shell.exec("busctl --user list 2>/dev/null | grep 'com.happytomatoe.[V]oiceToText'");
        return output.trim().length === 0;
      } catch {
        return false; // ssh hiccup during setup — retry
      }
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

  // Sanity probe: confirm the deployed source has an entrypoint and the
  // interpreter is present BEFORE we start it blind. Surfaces path/version
  // mistakes instead of a silent 60s bus-name timeout.
  try {
    const probe = await shell.exec(
      "ls -la $HOME/voice_to_text/src/voice_to_text/__main__.py 2>&1; " +
      "python3 --version 2>&1; cat $HOME/.config/voice-to-text/config.yaml 2>&1 | head -20"
    );
    console.log("  source probe:\n" + probe.trim().split("\n").map((l) => "    " + l).join("\n"));
  } catch (e) {
    console.log("  (source probe failed: " + (e as Error).message) + ")";
  }

  // Use $HOME (not ~) — tilde doesn't expand inside a scalar assignment under
  // dash/sh, so PYTHONPATH=~/voice_to_text/src would be taken literally and
  // the package would never import.
  await shell.exec(
    `export PATH=$HOME/.local/bin:$PATH; export XDG_RUNTIME_DIR=/run/user/$(id -u); export VOICE_TO_TEXT_PROVIDER=parakeet; export VOICE_TO_TEXT_DEBUG_FILE=/tmp/test-audio.wav; export VOICE_TO_TEXT_OUTPUT_METHOD=${outputMethod}; export PYTHONPATH=$HOME/voice_to_text/src; cd "$HOME"; setsid python3 -m voice_to_text > /tmp/voice-service.log 2>&1 < /dev/null &`
  );
  console.log("  voice service launched (logs -> /tmp/voice-service.log)");

  // Bus-name registration can be slow under host contention (Python import +
  // D-Bus handshake), so allow up to 60s before declaring it dead. On
  // timeout, dump the service log + process/bus state so the failure is
  // diagnosable instead of a bare "Timeout waiting for ...".
  try {
    await pollForCommandOutputFn(
      shell.exec.bind(shell),
      "busctl --user list 2>/dev/null | grep 'com.happytomatoe.[V]oiceToText'",
      "com.happytomatoe.VoiceToText",
      60000
    );
  } catch (err) {
    console.log("\n[voice-service] FAILED to register on D-Bus. Diagnostics:");
    // Use a fresh SSH connection (sshExec) — the persistent shell session is
    // dead after the 60s poll, so shell.exec would throw and hide the output.
    const dump = (label: string, cmd: string) => {
      try {
        const out = sshExec(cmd, cfg.sshKey, cfg.sshPort, cfg.sshUser);
        console.log(`--- ${label} ---\n` + out.trim().split("\n").map((l) => "  " + l).join("\n"));
      } catch (e) {
        console.log(`--- ${label} --- (failed: ${(e as Error).message})`);
      }
    };
    dump("/tmp/voice-service.log (tail)", "tail -n 80 /tmp/voice-service.log 2>/dev/null || echo '(no log file)'");
    dump("processes", "ps -eo pid,ppid,stat,cmd 2>/dev/null | grep -i voice_to_text | grep -v grep || echo '(no voice_to_text process running)'");
    dump("bus / provider", "busctl --user list 2>/dev/null | grep -i voice || echo '(no voice* bus names)'; echo '--- provider reachability ---'; (timeout 3 bash -c 'echo > /dev/tcp/10.0.2.2/5092' 2>/dev/null && echo 'parakeet host:5092 reachable') || echo 'parakeet host:5092 UNREACHABLE'");
    throw err;
  }
}
