/**
 * Health checks for GNOME Shell and the voice-to-text extension.
 *
 * Mirrors the approach from gnome-shell-system-monitor-next-applet:
 * simple SSH commands that check process state, extension status,
 * JS errors, and crash detection via PID comparison.
 */

export interface HealthCheckResult {
  gnomeShell: boolean;
  extensionActive: boolean;
  noJsErrors: boolean;
  noCrash: boolean;
  details: string[];
}

/**
 * Run all health checks on the VM.
 *
 * @param exec - SSH exec function (command → stdout string)
 * @param extensionUuid - UUID of the extension to check
 * @param preDeployPid - PID of gnome-shell before deployment (for crash detection)
 * @param since - journalctl --since filter (default: "5 minutes ago")
 */
export async function checkHealth(
  exec: (cmd: string) => Promise<string>,
  extensionUuid: string,
  preDeployPid?: string,
  since = "5 minutes ago"
): Promise<HealthCheckResult> {
  const details: string[] = [];
  let gnomeShell = false;
  let extensionActive = false;
  let noJsErrors = true;
  let noCrash = true;

  // 1. Check GNOME Shell is running
  try {
    const pid = (await exec("pgrep -x gnome-shell")).trim();
    gnomeShell = pid.length > 0;
    details.push(`GNOME Shell: ${gnomeShell ? `running (PID ${pid})` : "NOT RUNNING"}`);
  } catch {
    details.push("GNOME Shell: NOT RUNNING (pgrep failed)");
  }

  // 2. Check for crash (PID changed since pre-deploy)
  if (preDeployPid) {
    try {
      const postPid = (await exec("pgrep -x gnome-shell")).trim();
      if (!postPid) {
        noCrash = false;
        details.push("Crash: GNOME Shell is not running (fatal crash?)");
      } else if (preDeployPid !== postPid) {
        noCrash = false;
        details.push(`Crash: GNOME Shell restarted (${preDeployPid} → ${postPid})`);
      } else {
        details.push("Crash: none detected");
      }
    } catch {
      noCrash = false;
      details.push("Crash: could not check PID (gnome-shell may have crashed)");
    }
  }

  // 3. Check extension is active
  try {
    const dbusAddr = await getDbusAddr(exec);
    const state = (await exec(
      `DBUS_SESSION_BUS_ADDRESS=${dbusAddr} gnome-extensions show ${extensionUuid} 2>/dev/null | grep State:`
    )).trim();
    const cliActive = state.includes("ACTIVE");
    if (cliActive) {
      extensionActive = true;
      details.push(`Extension: ${state}`);
    } else {
      // gnome-extensions CLI doesn't register extensions installed by direct file copy.
      // Real signal: files present + dconf enabled-extensions contains the UUID.
      const present = (await exec(
        `test -f "$HOME/.local/share/gnome-shell/extensions/${extensionUuid}/metadata.json" && echo yes || echo no`
      )).trim();
      const dconfEnabled = (await exec(
        `DBUS_SESSION_BUS_ADDRESS=${dbusAddr} dconf read /org/gnome/shell/enabled-extensions 2>/dev/null | grep -q '${extensionUuid}' && echo yes || echo no`
      )).trim();
      if (present === "yes" && dconfEnabled === "yes") {
        extensionActive = true;
        details.push("Extension: ACTIVE (files + dconf; CLI unaware of manual install)");
      } else {
        details.push(`Extension: State: UNKNOWN (files=${present}, dconf=${dconfEnabled})`);
      }
    }
  } catch {
    details.push("Extension: State: UNKNOWN (check failed)");
  }

  // 4. Check for JS errors in journal
  try {
    const errors = (await exec(
      `journalctl --user -b --since '${since}' --no-pager 2>/dev/null | grep -i 'JS ERROR' | grep -i 'voice-to-text\\|happytomatoe' || true`
    )).trim();
    if (errors) {
      noJsErrors = false;
      details.push(`JS Errors: FOUND`);
      details.push(errors);
    } else {
      details.push("JS Errors: none");
    }
  } catch {
    details.push("JS Errors: none (journalctl failed)");
  }

  return { gnomeShell, extensionActive, noJsErrors, noCrash, details };
}

/**
 * Get D-Bus session address from gnome-shell's environment.
 */
async function getDbusAddr(exec: (cmd: string) => Promise<string>): Promise<string> {
  try {
    return (await exec(
      `cat /proc/$(pgrep -x gnome-shell | head -1)/environ 2>/dev/null | tr '\\0' '\\n' | grep ^DBUS_SESSION_BUS_ADDRESS= | cut -d= -f2-`
    )).trim();
  } catch {
    const uid = (await exec("id -u")).trim();
    return `unix:path=/run/user/${uid}/bus`;
  }
}

/**
 * Record the PID of gnome-shell before deployment.
 */
export async function recordPreDeployPid(
  exec: (cmd: string) => Promise<string>
): Promise<string> {
  try {
    return (await exec("pgrep -x gnome-shell")).trim();
  } catch {
    return "";
  }
}
