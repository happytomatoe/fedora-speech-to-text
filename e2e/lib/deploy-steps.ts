import { existsSync, readFileSync, chmodSync } from "node:fs";
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
      if (!(err as any).killed && (err as any).stdout) return (err as any).stdout.toString();
      if (i < retries - 1) execSync(`sleep 2`);
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

export function scpFromVm(remote: string, local: string, sshKey: string, sshPort: number, sshUser = "testuser"): void {
  const host = `${sshUser}@localhost`;
  const scpOpts = `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${sshKey} -P ${sshPort}`;
  execSync(`scp ${scpOpts} ${host}:${remote} ${local}`, { stdio: "pipe" });
}

function shellExec(cmd: string, sshKey: string, sshPort: number, sshUser = "testuser"): string {
  return sshExec(cmd, sshKey, sshPort, sshUser, 1, 30_000);
}

async function dExec(deployer: Deployer | undefined, cmd: string, sshKey: string, sshPort: number, sshUser = "testuser", timeoutSec = 120): Promise<string> {
  if (deployer) {
    const { stdout } = await deployer.exec(cmd, timeoutSec * 1000);
    return stdout;
  }
  return shellExec(cmd, sshKey, sshPort, sshUser);
}

// --- Upload scripts to VM ---

const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");

export async function uploadScripts(
  deployer: Deployer | undefined,
  cfg: { sshKey: string; sshPort: number; sshUser: string }
): Promise<void> {
  console.log("Uploading E2E scripts...");
  const scripts = ["setup-gdm.sh", "deploy-extension.sh", "start-voice-service.sh"];
  if (deployer) {
    await deployer.exec("mkdir -p ~/tmp-deploy/scripts");
    for (const s of scripts) {
      const src = join(SCRIPTS_DIR, s);
      if (existsSync(src)) await deployer.uploadFile(src, `~/tmp-deploy/scripts/${s}`);
    }
  } else {
    sshExec("mkdir -p ~/tmp-deploy/scripts", cfg.sshKey, cfg.sshPort, cfg.sshUser);
    for (const s of scripts) {
      const src = join(SCRIPTS_DIR, s);
      if (existsSync(src)) scpToVm(src, `~/tmp-deploy/scripts/${s}`, cfg.sshKey, cfg.sshPort, cfg.sshUser);
    }
  }
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
  outputMethod?: string;
}

// --- Deployment steps (script-based) ---

export async function waitForGdmLogin(
  shell: ShellHelper,
  sshKey: string,
  sshPort: number,
  sshUser = "testuser",
  serialLog?: string,
  deployer?: Deployer
): Promise<void> {
  const t0 = Date.now();

  // Upload scripts first
  await uploadScripts(deployer, { sshKey, sshPort, sshUser });

  // Run setup-gdm.sh (single SSH call)
  console.log("Running setup-gdm.sh...");
  try {
    const output = await dExec(deployer,
      "bash ~/tmp-deploy/scripts/setup-gdm.sh 2>&1",
      sshKey, sshPort, sshUser, 90
    );
    console.log(output.trim());
  } catch (e) {
    console.log("setup-gdm.sh failed:", (e as Error).message?.slice(0, 500));
    throw e;
  }

  const ready = await dExec(deployer, "pgrep -x gnome-shell >/dev/null && echo ready || echo not-ready", sshKey, sshPort, sshUser);
  if (!ready.includes("ready")) {
    // Dump debug info
    try {
      const log = await dExec(deployer, "cat /tmp/gnome-shell.log 2>/dev/null || echo '(no log)'", sshKey, sshPort, sshUser);
      console.log(`  gnome-shell log:\n${log.slice(0, 500)}`);
    } catch { /* ignore */ }
    if (serialLog && existsSync(serialLog)) {
      try {
        const serial = readFileSync(serialLog, "utf-8");
        console.log(`  serial log (last 50):\n${serial.split("\n").slice(-50).join("\n")}`);
      } catch { /* ignore */ }
    }
    throw new Error("gnome-shell did not start");
  }

  console.log(`  GDM setup: ${Date.now() - t0}ms [time]`);
}

export async function installDependencies(
  _sshKey: string,
  _sshPort: number,
  _sshUser: string,
  _deployer?: Deployer
): Promise<void> {
  // Dependencies are pre-installed in golden image or installed by setup-gdm.sh
  console.log("  Skipping installDependencies (handled by scripts)");
}

export async function deployExtension(
  shell: ShellHelper,
  cfg: DeployConfig,
  _pollUntilFn: typeof pollUntil,
  deployer?: Deployer
): Promise<void> {
  const extDir = join(cfg.projectRoot, "gnome-ext");
  if (!existsSync(extDir)) return;

  const t0 = Date.now();
  console.log("Deploying GNOME extension...");

  // Upload install.sh, gnome-ext, service files
  const tUpload = Date.now();
  if (deployer) {
    await deployer.exec('mkdir -p ~/tmp-deploy');
    // Parallel uploads — independent, no dependencies between them
    await Promise.all([
      deployer.uploadFile(join(cfg.projectRoot, 'install.sh'), '~/tmp-deploy/install.sh'),
      deployer.uploadDir(extDir, '~/tmp-deploy/gnome-ext'),
      deployer.uploadDir(join(cfg.projectRoot, 'service'), '~/tmp-deploy/service'),
    ]);
  } else {
    sshExec('mkdir -p ~/tmp-deploy', cfg.sshKey, cfg.sshPort, cfg.sshUser);
    // Parallel rsync — independent
    await Promise.all([
      Promise.resolve(rsyncToVm(join(cfg.projectRoot, 'install.sh'), '~/tmp-deploy/install.sh', cfg.sshKey, cfg.sshPort, cfg.sshUser)),
      Promise.resolve(rsyncToVm(extDir, '~/tmp-deploy/gnome-ext', cfg.sshKey, cfg.sshPort, cfg.sshUser)),
      Promise.resolve(rsyncToVm(join(cfg.projectRoot, 'service'), '~/tmp-deploy/service', cfg.sshKey, cfg.sshPort, cfg.sshUser)),
    ]);
  }
  console.log(`    upload: ${Date.now() - tUpload}ms [time]`);

  // Run deploy-extension.sh (single SSH call)
  const tDeploy = Date.now();
  try {
    const output = await dExec(deployer,
      `bash ~/tmp-deploy/scripts/deploy-extension.sh '${cfg.extensionUuid}' 2>&1`,
      cfg.sshKey, cfg.sshPort, cfg.sshUser, 300
    );
    console.log(output.trim());
  } catch (e) {
    console.log("deploy-extension.sh failed:", (e as Error).message?.slice(0, 500));
    throw e;
  }

  // deploy-extension.sh already kills gnome-shell and waits for respawn.
  // Just verify gnome-shell is running after the script completes.
  console.log("  Verifying gnome-shell is running...");
  let gnomeShellReady = false;
  for (let i = 0; i < 20; i++) {
    try {
      const ready = await dExec(deployer, 'pgrep -x gnome-shell >/dev/null && echo ready || echo not-ready', cfg.sshKey, cfg.sshPort, cfg.sshUser, 10);
      if (ready.includes('ready')) {
        console.log(`  gnome-shell ready (${i}s)`);
        gnomeShellReady = true;
        break;
      }
    } catch {
      // keep waiting
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!gnomeShellReady) {
    console.log("  WARNING: gnome-shell did not become ready within 40s");
  }

  // Enable the extension
  console.log("  Enabling extension...");
  const extUuid = cfg.extensionUuid;
  for (let i = 0; i < 10; i++) {
    try {
      const list = await dExec(deployer, `gnome-extensions list 2>/dev/null || true`, cfg.sshKey, cfg.sshPort, cfg.sshUser, 10);
      if (list.includes(extUuid)) {
        console.log(`  Extension discovered by GNOME Shell (${i}s)`);
        await dExec(deployer, `gnome-extensions enable '${extUuid}' 2>&1 || true`, cfg.sshKey, cfg.sshPort, cfg.sshUser, 10);
        break;
      }
    } catch {
      // keep trying
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Verify extension is active
  for (let i = 0; i < 10; i++) {
    try {
      const show = await dExec(deployer, `gnome-extensions show '${extUuid}' 2>/dev/null | grep State: || true`, cfg.sshKey, cfg.sshPort, cfg.sshUser, 10);
      if (show.toLowerCase().includes('active')) {
        console.log(`  Extension is ACTIVE`);
        break;
      }
    } catch {
      // keep trying
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`  deploy extension: ${Date.now() - t0}ms [time]`);
}

export async function deployPythonSource(cfg: DeployConfig, deployer?: Deployer): Promise<void> {
  if (!existsSync(cfg.pythonSrc)) return;
  console.log("Deploying Python source...");
  // Ensure parent directory exists (rsync can't create it)
  await dExec(deployer, "mkdir -p ~/voice_to_text/src/voice_to_text", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  // rsync --delete handles removed files; delta transfer skips unchanged files
  if (deployer) {
    await deployer.uploadDir(cfg.pythonSrc, "~/voice_to_text/src/voice_to_text");
  } else {
    rsyncToVm(cfg.pythonSrc, "~/voice_to_text/src/voice_to_text", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  }
}

export async function deployTestAudio(cfg: DeployConfig, deployer?: Deployer): Promise<void> {
  const testAudio = cfg.testAudioFile;
  if (!existsSync(testAudio)) return;
  console.log(`Deploying test audio: ${testAudio}`);
  if (deployer) {
    await deployer.uploadFile(testAudio, "/tmp/test-audio.wav");
  } else {
    scpToVm(testAudio, "/tmp/test-audio.wav", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  }
}

export async function startVoiceService(
  shell: ShellHelper,
  cfg: DeployConfig,
  _pollUntilFn: typeof pollUntil,
  _pollForCommandOutputFn: typeof pollForCommandOutput,
  skipDeps = false,
  deployer?: Deployer
): Promise<void> {
  const outputMethod = cfg.outputMethod || 'mutter-commit';
  console.log(`Starting voice service (output: ${outputMethod})...`);

  // Copy config
  await dExec(deployer, "mkdir -p ~/.config/voice-to-text", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  const configName = process.env.CI ? "voice-to-text-config.ci.yaml" : "voice-to-text-config.local.yaml";
  if (deployer) {
    await deployer.uploadFile(join(cfg.fixtureDir, configName), "~/.config/voice-to-text/config.yaml");
  } else {
    scpToVm(join(cfg.fixtureDir, configName), "~/.config/voice-to-text/config.yaml", cfg.sshKey, cfg.sshPort, cfg.sshUser);
  }

  // Run start-voice-service.sh (single SSH call)
  try {
    const output = await dExec(deployer,
      `bash ~/tmp-deploy/scripts/start-voice-service.sh '${outputMethod}' 2>&1`,
      cfg.sshKey, cfg.sshPort, cfg.sshUser, 30
    );
    console.log(output.trim());
  } catch (e) {
    console.log("start-voice-service.sh failed:", (e as Error).message?.slice(0, 500));
    throw e;
  }
}
