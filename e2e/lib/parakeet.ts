import net from "node:net";
import { execSync } from "node:child_process";
import { join } from "node:path";

export const PORT = 5092;
export const ENDPOINT = "http://10.0.2.2:5092";

function checkPort(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection(PORT, "localhost");
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 3000);
    s.on("connect", () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

/** Ensure Parakeet is running. Only starts if not already listening. */
export async function ensureParakeet(): Promise<void> {
  const modelsDir = join(process.env.HOME || process.env.USERPROFILE || ".", "parakeet", "models");
  const containerName = "parakeet-v2";

  // Fast path: already listening
  if (await checkPort()) {
    console.log("  Parakeet already running on port " + PORT);
    return;
  }

  // Container running but still loading models — poll until ready
  try {
    const state = execSync(`podman inspect -f '{{.State.Status}}' ${containerName} 2>/dev/null`).toString().trim();
    if (state === "running") {
      console.log(`  Parakeet container running, waiting for port ${PORT}...`);
      for (let i = 0; i < 45; i++) {
        if (await checkPort()) {
          console.log("  Parakeet ready on port " + PORT);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      // Container is stuck — restart it
      console.log("  WARNING: Parakeet not ready after 90s — restarting container");
      execSync(`podman rm -f ${containerName} 2>/dev/null || true`, { stdio: "ignore" });
    } else if (state !== "") {
      // Container exists but is stopped — remove and restart
      console.log(`  Parakeet container is ${state} — removing and restarting`);
      execSync(`podman rm -f ${containerName} 2>/dev/null || true`, { stdio: "ignore" });
    }
  } catch {
    // Container doesn't exist
  }

  // Start new container
  console.log("  Starting Parakeet container...");
  try {
    execSync(
      `podman run -d --name ${containerName} -p ${PORT}:5092 -v '${modelsDir}':/models:Z ghcr.io/achetronic/parakeet:latest`,
      { stdio: "inherit", timeout: 60_000 }
    );
    for (let i = 0; i < 45; i++) {
      if (await checkPort()) {
        console.log("  Parakeet ready on port " + PORT);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("Parakeet started but not ready after 90s");
  } catch (err) {
    console.log("  WARNING: Failed to start Parakeet:", err);
    throw new Error(`Failed to start Parakeet: ${err}`);
  }
}
