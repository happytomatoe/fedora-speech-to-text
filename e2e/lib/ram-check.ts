import { execSync } from "node:child_process";

/**
 * Get available RAM in MB from the host system.
 */
function getAvailableRamMb(): number {
  const output = execSync("free -m", { encoding: "utf-8" });
  // Line: "Mem:   15344  7200  584  ..."
  const memLine = output.split("\n").find(l => l.startsWith("Mem:"))!;
  const parts = memLine.split(/\s+/);
  // "available" column (index 6) is what matters — it includes buff/cache that can be reclaimed
  return parseInt(parts[6], 10);
}

/**
 * Count QEMU VMs that are using our project's overlay images.
 * Excludes unrelated QEMU processes (e.g., other projects, libvirt VMs).
 */
function countRunningE2eVms(): number {
  try {
    const output = execSync(
      `ps aux | grep "qemu-system-x86" | grep -v grep | grep -c "overlay.qcow2"`,
      { encoding: "utf-8", stdio: "pipe" }
    );
    return parseInt(output.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Check if there's enough RAM to start N new VMs.
 * Throws with a descriptive error if not.
 */
export function checkRamPreflight(requestedNewVms: number, vmMemMb = 4096): void {
  const availableMb = getAvailableRamMb();
  const runningVms = countRunningE2eVms();
  const totalVms = runningVms + requestedNewVms;
  const totalNeededMb = totalVms * vmMemMb;
  const maxFit = Math.floor(availableMb / vmMemMb);

  console.log(`  RAM check: ${availableMb}MB available, ${runningVms} E2E VM(s) running`);
  console.log(`  Requesting ${requestedNewVms} new VM(s) × ${vmMemMb}MB = ${totalNeededMb}MB total`);

  if (requestedNewVms > maxFit) {
    const msg = [
      `Not enough RAM for ${requestedNewVms} VM(s).`,
      ``,
      `  Available:  ${availableMb}MB`,
      `  Per VM:     ${vmMemMb}MB`,
      `  Max fit:    ${maxFit} VM(s)`,
      `  Requested:  ${requestedNewVms} VM(s)`,
      runningVms > 0 ? `  Already running: ${runningVms} VM(s)` : ``,
      ``,
      `Options:`,
      `  - Reduce --parallel to ${maxFit} or less`,
      `  - Use --vm-mem to reduce RAM per VM (current: ${vmMemMb}MB)`,
      `  - Close other applications to free RAM`,
      runningVms > 0 ? `  - Stop existing E2E VMs first` : ``,
    ].filter(Boolean).join("\n");

    throw new Error(msg);
  }

  if (totalVms >= maxFit) {
    console.log(`  ⚠️  Warning: ${totalVms} VM(s) will use most available RAM. System may be slow.`);
  } else {
    console.log(`  ✅ Enough RAM for ${requestedNewVms} new VM(s) (${maxFit} max)`);
  }
}
