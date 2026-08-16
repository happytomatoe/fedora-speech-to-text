import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface E2eTimeouts {
  global: number;
  boot_vm: number;
  wait_ssh: number;
  setup: number;
  ssh_exec: number;
  install_sh: number;
  gnome_shell: number;
  gdm_restart: number;
  gdm_active: number;
  user_session: number;
  shell_dbus: number;
  extension_ready: number;
  transcription: number;
}

const DEFAULTS: E2eTimeouts = {
  global: 300,
  boot_vm: 120,
  wait_ssh: 120,
  setup: 600,
  ssh_exec: 120,
  install_sh: 180,
  gnome_shell: 180,
  gdm_restart: 5,
  gdm_active: 30,
  user_session: 30,
  shell_dbus: 30,
  extension_ready: 30,
  transcription: 30,
};

let _timeouts: E2eTimeouts | null = null;

export function loadTimeouts(): E2eTimeouts {
  if (_timeouts) return _timeouts;
  try {
    const raw = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf-8");
    const parsed = parse(raw);
    _timeouts = { ...DEFAULTS, ...parsed?.timeouts };
  } catch {
    _timeouts = { ...DEFAULTS };
  }
  return _timeouts!;
}

/** Get a single timeout value in milliseconds */
export function timeoutMs(key: keyof E2eTimeouts): number {
  return loadTimeouts()[key] * 1000;
}
