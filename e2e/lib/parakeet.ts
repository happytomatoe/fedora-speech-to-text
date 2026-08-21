import { execSync } from "node:child_process";
import http from "node:http";

export const PORT = 5092;
export const ENDPOINT = "http://10.0.2.2:5092";

function checkHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PORT}/health`, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

function startContainer(): boolean {
  // Detect runtime (podman or docker)
  let rt = "";
  for (const r of ["podman", "docker"]) {
    try {
      execSync(`command -v ${r}`, { stdio: "ignore" });
      rt = r;
      break;
    } catch { /* not found */ }
  }
  if (!rt) return false;

  const modelsDir = `${process.env.HOME}/parakeet/models`;
  try {
    execSync(`mkdir -p "${modelsDir}"`, { stdio: "ignore" });
    execSync(
      `${rt} run -d --name parakeet-v2 -p ${PORT}:${PORT} -v "${modelsDir}:/models:Z" ghcr.io/achetronic/parakeet:latest`,
      { stdio: "ignore" }
    );
  } catch {
    // Container may already exist (name conflict) — try to start it
    try {
      execSync(`${rt} start parakeet-v2`, { stdio: "ignore" });
    } catch { /* give up */ }
  }
  return true;
}

/** Verify Parakeet is running. Starts container if not (for local testing). */
export async function ensureParakeet(): Promise<void> {
  if (await checkHealth()) {
    console.log("  Parakeet running on port " + PORT);
    return;
  }

  // Try to start the container
  const started = startContainer();

  // Wait up to 30s for healthy
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await checkHealth()) {
      console.log(`  Parakeet started on port ${PORT}${started ? " (auto-started)" : ""}`);
      return;
    }
  }

  throw new Error(
    `Parakeet not running on port ${PORT}. ` +
    "Start it manually: podman run -d --name parakeet-v2 -p 5092:5092 -v ~/parakeet/models:/models:Z ghcr.io/achetronic/parakeet:latest"
  );
}
