import http from "node:http";
import { execSync } from "node:child_process";
import { join } from "node:path";

export const PORT = 5092;
export const ENDPOINT = "http://10.0.2.2:5092";

/** Detect available container runtime: podman or docker. */
function detectRuntime(): string {
  for (const rt of ["podman", "docker"]) {
    try {
      execSync(`${rt} --version`, { stdio: "ignore" });
      // Test with volume mount + port (like real parakeet container)
      execSync(`${rt} run --rm alpine echo ok`, { stdio: "ignore", timeout: 30_000 });
      return rt;
    } catch (e) { console.warn(`  ${rt} not available: ${e instanceof Error ? e.message : e}`); }
  }
  throw new Error("No working container runtime found (need podman or docker)");
}

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

/** Ensure Parakeet is running. Only starts if not already listening. */
export async function ensureParakeet(): Promise<void> {
  const modelsDir = join(process.env.HOME || process.env.USERPROFILE || ".", "parakeet", "models");
  const containerName = "parakeet-v2";

  // Fast path: already listening
  if (await checkHealth()) {
    console.log("  Parakeet already running on port " + PORT);
    return;
  }

  const rt = detectRuntime();
  console.log(`  Using container runtime: ${rt}`);

  // Ensure models directory exists and download models if needed
  execSync(`mkdir -p '${modelsDir}'`, { stdio: "ignore" });
  const requiredFiles = ["config.json", "vocab.txt", "nemo128.onnx", "encoder-model.int8.onnx", "decoder_joint-model.int8.onnx"];
  const modelsExist = requiredFiles.every((f) => {
    try {
      execSync(`test -f '${modelsDir}/${f}'`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!modelsExist) {
    console.log("  Downloading Parakeet models...");
    const baseUrl = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main";
    for (const f of requiredFiles) {
      console.log(`    Downloading ${f}...`);
      execSync(`curl -L -f -o '${modelsDir}/${f}' '${baseUrl}/${f}'`, { stdio: "inherit", timeout: 300_000 });
    }
    console.log("  Models downloaded.");
  }

  // Container running but still loading models — poll until ready
  try {
    const state = execSync(`${rt} inspect -f '{{.State.Status}}' ${containerName} 2>/dev/null`).toString().trim();
    if (state === "running") {
      console.log(`  Parakeet container running, waiting for port ${PORT}...`);
      for (let i = 0; i < 45; i++) {
        if (await checkHealth()) {
          console.log("  Parakeet ready on port " + PORT);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      // Container is stuck — restart it
      console.log("  WARNING: Parakeet not ready after 90s — restarting container");
      execSync(`${rt} rm -f ${containerName} 2>/dev/null || true`, { stdio: "ignore" });
    } else if (state !== "") {
      // Container exists but is stopped — remove and restart
      console.log(`  Parakeet container is ${state} — removing and restarting`);
      execSync(`${rt} rm -f ${containerName} 2>/dev/null || true`, { stdio: "ignore" });
    }
  } catch { console.log("  No existing Parakeet container found");
    // Container doesn't exist
  }

  // Start new container
  console.log("  Starting Parakeet container...");
  try {
    execSync(
      `${rt} run -d --name ${containerName} -p ${PORT}:5092 -v '${modelsDir}':/models:Z ghcr.io/achetronic/parakeet:latest`,
      { stdio: "inherit", timeout: 60_000 }
    );
    for (let i = 0; i < 45; i++) {
      if (await checkHealth()) {
        console.log("  Parakeet ready on port " + PORT);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("Parakeet started but not ready after 90s");
  } catch (err) {
    console.log("  WARNING: Failed to start Parakeet:", err);
    throw new Error(`Failed to start Parakeet: ${err instanceof Error ? err.message : err}`, { cause: err });
  }
}
