/** `npm run worker` — the background job processor. Run at least one alongside the web app. */
import { loadDotEnv } from "./env";

async function main() {
  loadDotEnv();
  const { ensureEnv } = await import("./pg");
  ensureEnv();
  const { runWorker } = await import("../src/server/jobs/worker");
  await runWorker();
  process.exit(0);
}
main().catch((e) => { console.error("[worker]", e); process.exit(1); });
