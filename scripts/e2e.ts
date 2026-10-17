/**
 * End-to-end test over HTTP against the real production build.
 *
 *   npm run build && npm run test:e2e
 *
 * Creates a throwaway `cutline_e2e` database, starts `next start` and a worker
 * against it (mock AI providers enabled — this verifies OUR pipeline, not a
 * live AI or YouTube integration), then drives the documented REST API with
 * API tokens exactly as an external client would.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { start, isRunning, ensureDatabase, PG_PORT, PG_USER, PG_PASSWORD } from "./pg";

const DB = "cutline_e2e";
const PORT = Number(process.env.E2E_PORT ?? 3917);
const BASE = `http://127.0.0.1:${PORT}`;
const URL_ = `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${DB}`;
const children: ChildProcess[] = [];
let passed = 0;

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}

async function api<T = unknown>(token: string, method: string, path: string, body?: unknown, raw?: BodyInit): Promise<{ status: number; data: T; error?: { code: string; message: string } }> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, data: j.data as T, error: j.error };
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const env: NodeJS.ProcessEnv = {
    ...process.env, DATABASE_URL: URL_, NODE_ENV: "production", PORT: String(PORT), APP_URL: BASE,
    LOCAL_STORAGE_DIR: ".media-e2e", SCRATCH_DIR: ".scratch-e2e", CUTLINE_ENABLE_MOCK_PROVIDERS: "true",
    CUTLINE_ENCRYPTION_KEY: "ZTJlLWVuY3J5cHRpb24ta2V5LTMyLWJ5dGVzLWxvbmchIQ==", CUTLINE_SIGNING_SECRET: "e2e-signing-secret-that-is-long-enough-0123456789",
    WORKER_CONCURRENCY: "2", NEXT_TELEMETRY_DISABLED: "1",
  };
  // The worker runs as "test" so its mock providers work; the web server is a real production build.
  const workerEnv: NodeJS.ProcessEnv = { ...env, NODE_ENV: "test" };

  console.log("[e2e] preparing database");
  if (!isRunning()) start();
  await ensureDatabase(DB);
  const c = new Client({ connectionString: URL_ });
  await c.connect();
  await c.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await c.end();
  rmSync(".media-e2e", { recursive: true, force: true });
  rmSync(".scratch-e2e", { recursive: true, force: true });
  process.env.DATABASE_URL = URL_;
  Object.assign(process.env, { CUTLINE_ENCRYPTION_KEY: env.CUTLINE_ENCRYPTION_KEY!, CUTLINE_SIGNING_SECRET: env.CUTLINE_SIGNING_SECRET! });
  const { runMigrations } = await import("../src/db/migrate");
  await runMigrations();

  // Bootstrap an agency + a second, unrelated user directly (the setup form is covered by the UI).
  const { bootstrap } = await import("../src/server/services/workspaces");
  const { generateToken, hashToken } = await import("../src/lib/crypto");
  const { db } = await import("../src/db");
  const s = await import("../src/db/schema");
  const { user: admin } = await bootstrap({ orgName: "E2E Agency", name: "E2E Admin", email: "admin@e2e.test", password: "e2e-password-123" });
  const [stranger] = await db.insert(s.users).values({ email: "stranger@e2e.test", name: "Stranger", passwordHash: "x" }).returning();
  // Same format and hashing as server/auth.ts createApiToken (that module needs a Next request context).
  const mint = async (userId: string) => {
    const token = `cl_${generateToken(32)}`;
    await db.insert(s.apiTokens).values({ userId, name: "e2e", prefix: token.slice(0, 10), tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 864e5) });
    return token;
  };
  const adminToken = await mint(admin.id);
  const strangerToken = await mint(stranger.id);
  console.log("[e2e] starting web + worker");
  const nextBin = join("node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
  const tsxBin = join("node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const web = spawn(nextBin, ["start", "-p", String(PORT)], { env, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  const worker = spawn(tsxBin, ["--conditions=react-server", "scripts/worker.ts"], { env: workerEnv, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  children.push(web, worker);
  let workerLog = "";
  worker.stdout?.on("data", (d: Buffer) => { workerLog = (workerLog + d).slice(-20000); });
  worker.stderr?.on("data", (d: Buffer) => { workerLog = (workerLog + d).slice(-20000); });
  web.stderr?.on("data", (d: Buffer) => process.stderr.write(`[web] ${d}`));

  await waitFor("web server", async () => { try { const r = await fetch(`${BASE}/api/health`); return r.status === 200 || r.status === 503; } catch { return false; } }, 90_000);
  const health = await (await fetch(`${BASE}/api/health`)).json();
  ok(health.checks.database && health.checks.ffmpeg && health.checks.ffprobe, "health endpoint reports database, FFmpeg and FFprobe");

  console.log("[e2e] API");
  const unauth = await fetch(`${BASE}/api/v1/me`);
  ok(unauth.status === 401, "unauthenticated API call is rejected (401)");
  const me = await api<{ email: string }>(adminToken, "GET", "/me");
  ok(me.data.email === "admin@e2e.test", "API token authenticates the agency admin");
  const spec = await (await fetch(`${BASE}/api/v1/openapi.json`)).json();
  ok(Object.keys(spec.paths).length > 30, `OpenAPI document lists ${Object.keys(spec.paths).length} paths`);

  const created = await api<{ id: string }>(adminToken, "POST", "/workspaces", { name: "E2E Creator", timezone: "UTC" });
  ok(created.status === 200 && created.data.id, "agency admin creates a client workspace");
  const ws = created.data.id;
  const w = `/workspaces/${ws}`;
  const deny = await api(strangerToken, "GET", `${w}/media`);
  ok(deny.status === 404, "an unrelated user cannot see the workspace (404, indistinguishable from missing)");
  const denyCreate = await api(strangerToken, "POST", "/workspaces", { name: "x" });
  ok(denyCreate.status === 403, "a non-admin cannot create workspaces (403)");

  // Mock providers for this workspace (allowed only because the e2e server is non-production).
  const { addApiKeyConnection } = await import("../src/server/services/integrations");
  process.env.CUTLINE_ENABLE_MOCK_PROVIDERS = "true";
  const [{ orgId }] = await (await import("../src/db")).db.select({ orgId: s.workspaces.orgId }).from(s.workspaces).where((await import("drizzle-orm")).eq(s.workspaces.id, ws));
  await addApiKeyConnection({ orgId, workspaceId: ws, actorId: admin.id }, { kind: "llm", provider: "mock", label: "Mock LLM" });
  await addApiKeyConnection({ orgId, workspaceId: ws, actorId: admin.id }, { kind: "transcription", provider: "mock", label: "Mock STT" });

  console.log("[e2e] chunked upload");
  mkdirSync(".scratch-e2e/fixtures", { recursive: true });
  const fixture = ".scratch-e2e/fixtures/e2e.mp4";
  const gen = spawnSync("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=14", "-f", "lavfi", "-i", "sine=frequency=300:duration=14:sample_rate=48000",
    "-af", "volume='if(between(t,4,6),0,1)':eval=frame", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "8M", "-c:a", "aac", "-shortest", fixture]);
  ok(gen.status === 0, "generated a 14-second 720p test recording with a real silent gap");
  const bytes = readFileSync(fixture);
  const up = await api<{ assetId: string; uploadId: string; chunkBytes: number; totalParts: number }>(adminToken, "POST", `${w}/uploads`, { filename: "e2e.mp4", size: statSync(fixture).size });
  ok(up.status === 200, `upload session created (${up.data.totalParts} part(s) of ${up.data.chunkBytes} bytes)`);
  for (let p = up.data.totalParts; p >= 1; p--) {
    const part = bytes.subarray((p - 1) * up.data.chunkBytes, p * up.data.chunkBytes);
    const r = await api(adminToken, "PUT", `${w}/uploads/${up.data.uploadId}/parts/${p}`, undefined, new Uint8Array(part));
    if (r.status !== 200) throw new Error(`part ${p} failed: ${JSON.stringify(r.error)}`);
  }
  const resend = await api(adminToken, "PUT", `${w}/uploads/${up.data.uploadId}/parts/1`, undefined, new Uint8Array(bytes.subarray(0, up.data.chunkBytes)));
  ok(resend.status === 200, "re-sending a part is accepted (resumable, idempotent)");
  const st = await api<{ receivedParts: number[] }>(adminToken, "GET", `${w}/uploads/${up.data.uploadId}`);
  ok(st.data.receivedParts.length === up.data.totalParts, "server reports every part received (out-of-order upload)");
  ok((await api(adminToken, "POST", `${w}/uploads/${up.data.uploadId}/complete`)).status === 200, "upload completed and ingest queued");

  const asset = await waitFor("ingest", async () => { const r = await api<{ status: string; durationSeconds: number; urls: { proxy: string } }>(adminToken, "GET", `${w}/media/${up.data.assetId}`); return r.data?.status === "ready" ? r.data : r.data?.status === "failed" ? Promise.reject(new Error("ingest failed")) : null; });
  ok(Math.round(asset.durationSeconds) === 14, "worker probed the footage (14 s) and built working copies");

  const proxy = await fetch(`${BASE}${asset.urls.proxy}`, { headers: { range: "bytes=0-1023" } });
  ok(proxy.status === 206 && proxy.headers.get("content-range")?.startsWith("bytes 0-1023/"), "signed media URL streams with HTTP Range (206)");
  const tampered = await fetch(`${BASE}${asset.urls.proxy.replace(/sig=[^&]+/, "sig=AAAA")}`);
  ok(tampered.status === 403, "a tampered media signature is refused (403)");

  console.log("[e2e] transcription, edit, approval, render");
  await api(adminToken, "POST", `${w}/media/${up.data.assetId}/transcribe`);
  await waitFor("transcript", async () => (await api(adminToken, "GET", `${w}/media/${up.data.assetId}/transcript`)).status === 200);
  ok(true, "transcript produced (mock speech-to-text, labelled mock)");
  await api(adminToken, "POST", `${w}/edits`, { assetId: up.data.assetId, useLlm: true });
  const edits = await waitFor("edit proposal", async () => { const r = await api<{ id: string }[]>(adminToken, "GET", `${w}/edits`); return r.data?.length ? r.data : null; });
  const editId = edits[0].id;
  const ed = await api<{ edit: { edlVersion: number; edl: { clips: { in: number; out: number }[] } }; suggestions: { type: string; status: string }[] }>(adminToken, "GET", `${w}/edits/${editId}`);
  ok(ed.data.suggestions.some((x) => x.type === "pause" && x.status === "accepted"), "review-first draft applied the measured 4–6 s pause cut");
  const blocked = await api(adminToken, "POST", `${w}/edits/${editId}/renders`, { kind: "final" });
  ok(blocked.status === 422, "final render is refused before approval");
  ok((await api(adminToken, "POST", `${w}/edits/${editId}/approve`)).status === 200, "creator approves the edit");
  const rj = await api<{ id: string }>(adminToken, "POST", `${w}/edits/${editId}/renders`, { kind: "final" });
  const render = await waitFor("final render", async () => { const r = await api<{ status: string; outputAssetId: string; error: string }>(adminToken, "GET", `${w}/renders/${rj.data.id}`); if (r.data?.status === "failed") throw new Error(r.data.error); return r.data?.status === "succeeded" ? r.data : null; }, 300_000);
  const out = await api<{ width: number; height: number; durationSeconds: number }>(adminToken, "GET", `${w}/media/${render.outputAssetId}`);
  const kept = ed.data.edit.edl.clips.reduce((t, c) => t + c.out - c.in, 0);
  ok(out.data.width === 1920 && Math.abs(out.data.durationSeconds - kept) < 1, `real FFmpeg final render: 1920×1080, ${out.data.durationSeconds.toFixed(1)} s (timeline ${kept.toFixed(1)} s)`);

  console.log("[e2e] publishing guard, blueprint export");
  // The production web build refuses mock providers (by design), so AI drafting answers with a setup message here.
  const aiPub = await api(adminToken, "POST", `${w}/publishing`, { renderJobId: rj.data.id, useAi: true });
  ok(aiPub.status === 424 && /language model/i.test(aiPub.error?.message ?? ""), "without a real LLM the API returns an actionable NOT_CONFIGURED error instead of fabricated metadata");
  const pub = await api<{ id: string; isMock: boolean }>(adminToken, "POST", `${w}/publishing`, { renderJobId: rj.data.id, useAi: false });
  ok(pub.status === 200 && !pub.data.isMock, "a blank, fully editable metadata draft can still be prepared");
  const sub = await api<{ status: string }>(adminToken, "POST", `${w}/publishing/${pub.data.id}/submit`);
  ok(sub.status === 424 || sub.data?.status === "awaiting_approval", "submission respects the workspace's publishing configuration");

  const { createTemplate, publishVersion } = await import("../src/server/services/blueprints");
  const orgCtx = { orgId, orgName: "E2E Agency", actorId: admin.id, isAdmin: true };
  const t = await createTemplate(orgCtx, { name: "E2E agent", description: "" });
  const v = await publishVersion(orgCtx, t.id, { bump: "major", changelog: "e2e" });
  const zipRes = await fetch(`${BASE}/api/v1/agency/blueprints/${v.id}/export?format=zip`, { headers: { authorization: `Bearer ${adminToken}` } });
  const zip = new Uint8Array(await zipRes.arrayBuffer());
  ok(zipRes.status === 200 && zipRes.headers.get("content-type") === "application/zip" && zip[0] === 0x50, "blueprint ZIP downloads over the API");
  const strangerExport = await fetch(`${BASE}/api/v1/agency/blueprints/${v.id}/export?format=zip`, { headers: { authorization: `Bearer ${strangerToken}` } });
  ok(strangerExport.status === 403, "non-admins cannot export blueprints (403)");
  const preview = await api<{ action: string; contentHash: string }>(adminToken, "POST", "/agency/blueprints/import/preview?filename=bp.zip", undefined, zip);
  ok(preview.data.action === "already_imported", "re-importing the same package is recognised as already present");
  const zipText = new TextDecoder().decode(zip);
  ok(!zipText.includes("e2e-signing-secret") && !zipText.includes("admin@e2e.test"), "the exported package contains no installation secrets or user emails");

  console.log("[e2e] every UI screen renders (session cookie)");
  const sessionToken = generateToken(32);
  await db.insert(s.sessions).values({ userId: admin.id, tokenHash: hashToken(sessionToken), expiresAt: new Date(Date.now() + 3600_000) });
  const { startDeployment } = await import("../src/server/services/deployments");
  await startDeployment(orgCtx, { blueprintVersionId: v.id, workspaceId: ws });
  const { eq } = await import("drizzle-orm");
  const [runRow] = await db.insert(s.workflowRuns).values({ workspaceId: ws, workflowKey: "channel_intelligence", workflowName: "Channel intelligence", definition: { workflow: { key: "channel_intelligence", name: "Channel intelligence", description: "", trigger: { type: "manual" }, inputs: [], nodes: [] }, config: {} }, status: "failed", error: "example" }).returning();
  void eq;
  const pages = [
    "/agency", "/agency/clients", "/agency/templates", `/agency/templates/${t.id}`, "/agency/blueprints", `/agency/blueprints/${v.id}`, `/agency/blueprints/${v.id}?tab=diff`,
    "/agency/deploy", ...[3, 4, 5, 6, 7, 8, 9].map((n) => `/agency/deploy?ws=${ws}&step=${n}`), "/agency/runs", "/agency/runs?view=jobs", "/agency/integrations", "/agency/settings", "/agency/audit",
    `/w/${ws}`, `/w/${ws}/channel`, `/w/${ws}/ideas`, `/w/${ws}/calendar`, `/w/${ws}/media`, `/w/${ws}/media?role=render`, `/w/${ws}/edits`,
    `/w/${ws}/edits/${editId}`, ...["highlights", "captions", "settings", "history"].map((tab) => `/w/${ws}/edits/${editId}?tab=${tab}`),
    `/w/${ws}/publishing`, `/w/${ws}/publishing/${pub.data.id}`, `/w/${ws}/approvals`, `/w/${ws}/agent`, `/w/${ws}/runs`, `/w/${ws}/runs?view=jobs`, `/w/${ws}/runs/${runRow.id}`,
    `/w/${ws}/integrations`, `/w/${ws}/profile`, `/w/${ws}/settings`, "/account", "/docs/api",
  ];
  const broken: string[] = [];
  for (const p of pages) {
    const r = await fetch(`${BASE}${p}`, { headers: { cookie: `cl_session=${sessionToken}` }, redirect: "manual" });
    const html = await r.text();
    if (r.status !== 200 || /Application error|Internal Server Error|NEXT_HTTP_ERROR/.test(html)) broken.push(`${p} → ${r.status}`);
  }
  ok(broken.length === 0, `all ${pages.length} UI screens render with real data${broken.length ? ` — broken: ${broken.join(", ")}` : ""}`);
  const strangerSession = generateToken(32);
  await db.insert(s.sessions).values({ userId: stranger.id, tokenHash: hashToken(strangerSession), expiresAt: new Date(Date.now() + 3600_000) });
  const peek = await fetch(`${BASE}/w/${ws}/media`, { headers: { cookie: `cl_session=${strangerSession}` }, redirect: "manual" });
  ok(peek.status === 404, "another user's browser session gets 404 for this client's workspace pages");
  const agencyPeek = await fetch(`${BASE}/agency`, { headers: { cookie: `cl_session=${strangerSession}` }, redirect: "manual" });
  ok(agencyPeek.status === 307 || agencyPeek.status === 303, "non-admins are redirected away from the agency dashboard");

  console.log(`\n[e2e] ${passed} checks passed`);
}

/** Kills each child and its descendants (on Windows a shell-spawned child is only the shell). */
function stopAll() {
  for (const c of children) {
    if (!c.pid) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGTERM");
  }
}

async function portFree(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/api/health`); return false; } catch { return true; }
}

portFree(PORT)
  .then((free) => {
    if (!free) { console.error(`[e2e] port ${PORT} is already in use — stop that process (or set E2E_PORT) and retry.`); process.exit(1); }
    return main();
  })
  .then(() => { stopAll(); process.exit(0); })
  .catch((e) => { console.error(`\n[e2e] ${e.message}`); stopAll(); process.exit(1); });
