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

/** Verify Parakeet is running. CI starts the container; this just checks. */
export async function ensureParakeet(): Promise<void> {
  if (await checkHealth()) {
    console.log("  Parakeet running on port " + PORT);
    return;
  }
  throw new Error(
    `Parakeet not running on port ${PORT}. ` +
    "CI should start it before E2E tests, or run: podman run -d --name parakeet-v2 -p 5092:5092 -v ~/parakeet/models:/models:Z ghcr.io/achetronic/parakeet:latest"
  );
}
