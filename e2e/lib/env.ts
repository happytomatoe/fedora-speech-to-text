import { existsSync } from "node:fs";
import { join } from "node:path";

export type EnvName = "fedora-local" | "ubuntu-local" | "ubuntu-ci";
export type Os = "fedora" | "ubuntu";

export const UBUNTU_2604_CLOUD_IMAGE =
  "https://cloud-images.ubuntu.com/daily/server/resolute/current/resolute-server-cloudimg-amd64.img";

/**
 * Everything that differs between environments, hidden behind one interface.
 * Suite logic (test flow, deploy steps, fixtures) depends on this object only;
 * adding an environment means adding a factory function here, not touching
 * the suite.
 */
export interface SuiteEnv {
  readonly name: EnvName;
  readonly os: Os;
  /** Pinned base image path (golden image, pre-customized). */
  readonly baseImage: string;
  /** SSH key for VMs this suite boots itself. */
  readonly sshKey: string;
  /** SSH key when attaching to an externally-managed VM (--use-existing). */
  readonly existingSshKey?: string;
  /** Port of the externally-managed VM (--use-existing). */
  readonly existingSshPort?: number;
  readonly referencesDir: string;
  /** Where overlays/pids/logs for runs live. */
  readonly vmDir: string;
  readonly gdmConfPath: string;
  /** Cloud image URL for first-time setup (ubuntu only). */
  readonly cloudImageUrl?: string;

  /** Check whether a system package is installed (remote command). */
  pkgIsInstalled(pkg: string): string;
  /** Install system packages (remote command). */
  pkgInstall(pkgs: string): string;
  /** How to get dotool onto the VM. */
  readonly dotool: { kind: "copr" } | { kind: "bundled"; dir: string };
  /** uv pip install command prefix (PEP 668 differs per distro). */
  readonly uvSystemInstall: boolean;
}

function fedoraEnv(suiteDir: string): SuiteEnv {
  const baseImage = (() => {
    const goldenDeps = join(suiteDir, "qemu-images/golden-gnome-deps.qcow2");
    if (existsSync(goldenDeps)) return goldenDeps;
    const depsBase = join(suiteDir, "qemu-images/base-with-deps.qcow2");
    if (existsSync(depsBase)) return depsBase;
    const uvBase = join(suiteDir, "qemu-images/base-with-uv.qcow2");
    if (existsSync(uvBase)) return uvBase;
    return join(suiteDir, "qemu-images/base.qcow2");
  })();
  return {
    name: "fedora-local",
    os: "fedora",
    baseImage,
    sshKey: join(suiteDir, "qemu-images/id_ed25519"),
    referencesDir: join(suiteDir, "expected-qemu"),
    vmDir: join(suiteDir, "qemu-images"),
    gdmConfPath: "/etc/gdm/custom.conf",
    pkgIsInstalled: (pkg) => `rpm -q ${pkg} 2>/dev/null || echo missing`,
    pkgInstall: (pkgs) => `sudo dnf install -y ${pkgs} 2>/dev/null`,
    dotool: { kind: "copr" },
    uvSystemInstall: false,
  };
}

function ubuntuEnv(suiteDir: string, name: EnvName): SuiteEnv {
  return {
    name,
    os: "ubuntu",
    baseImage: join(suiteDir, "ubuntu-2604-cloud.qcow2"),
    sshKey: join(suiteDir, "id_ed25519"),
    existingSshKey: join(suiteDir, "../e2e-vm/id_ed25519"),
    existingSshPort: 2222,
    referencesDir: join(suiteDir, "expected-ubuntu"),
    vmDir: join(suiteDir, "qemu-images"),
    gdmConfPath: "/etc/gdm3/custom.conf",
    cloudImageUrl: UBUNTU_2604_CLOUD_IMAGE,
    pkgIsInstalled: (pkg) =>
      `dpkg -s ${pkg} 2>/dev/null | grep -q 'Status: install ok installed' && echo ok || echo missing`,
    pkgInstall: (pkgs) =>
      `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkgs} 2>/dev/null`,
    dotool: { kind: "bundled", dir: suiteDir },
    uvSystemInstall: true,
  };
}

export function resolveEnv(
  suiteDir: string,
  name: EnvName | undefined,
  useExisting: boolean,
): SuiteEnv {
  const env = !name || name === "fedora-local"
    ? fedoraEnv(suiteDir)
    : ubuntuEnv(suiteDir, name);
  // ubuntu-ci: CI runs the bare-runner headless harness
  // (.github/workflows/scripts/ci-e2e-headless.sh) on ubuntu-26.04, not this
  // QEMU path. The VM-based env here is kept for local reproduction of CI
  // failures; see docs/CI-E2E-STATUS.md for the decision record.
  if (useExisting && env.existingSshKey) {
    return { ...env, sshKey: env.existingSshKey };
  }
  return env;
}
