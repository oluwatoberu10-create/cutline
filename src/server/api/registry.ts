import "server-only";
import { z } from "zod";
import { AppError, toFailure, unauthenticated } from "@/lib/errors";
import { actorFromRequest, type Actor } from "../auth";
import { log } from "../logger";
import { enforceRate } from "../services/audit";
import { primaryOrg, requireOrgAdmin, requireWorkspace, type OrgCtx, type Permission, type WorkspaceCtx } from "../tenancy";

/**
 * The REST API is defined once, here: method, path, auth requirement, input
 * and output schemas, and the handler. The same definitions produce the
 * OpenAPI document served at /api/v1/openapi.json, so the docs cannot drift.
 *
 * Every route authenticates (API token or session), is rate limited per
 * actor, and — for workspace routes — proves access through requireWorkspace
 * before the handler runs.
 */

export type RouteCtx = { actor: Actor; params: Record<string, string>; req: Request; ws?: WorkspaceCtx; org?: OrgCtx };

export type RouteDef = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  tag: string;
  /** "agency" = organization administrators; otherwise the workspace permission needed. */
  access: "user" | "agency" | { workspace: Permission };
  body?: z.ZodType;
  query?: z.ZodType;
  /** Raw request body (binary uploads). */
  rawBody?: boolean;
  response?: z.ZodType;
  handler: (ctx: RouteCtx, input: { body: unknown; query: unknown }) => Promise<unknown>;
};

const routes: RouteDef[] = [];

export function route(def: RouteDef) {
  routes.push(def);
}

export function allRoutes(): readonly RouteDef[] {
  return routes;
}

function match(def: RouteDef, method: string, path: string): Record<string, string> | null {
  if (def.method !== method) return null;
  const a = def.path.split("/").filter(Boolean), b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("{")) params[a[i].slice(1, -1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export async function dispatch(req: Request, path: string): Promise<Response> {
  const method = req.method.toUpperCase();
  let def: RouteDef | undefined, params: Record<string, string> | null = null;
  for (const r of routes) { params = match(r, method, path); if (params) { def = r; break; } }
  if (!def || !params) {
    const exists = routes.some((r) => match({ ...r, method: method as RouteDef["method"] }, method, path));
    return Response.json({ success: false, error: { code: "NOT_FOUND", message: exists ? "Method not allowed." : "Unknown endpoint." } }, { status: exists ? 405 : 404 });
  }
  try {
    const actor = await actorFromRequest(req);
    if (!actor) throw unauthenticated("Send a session cookie or 'Authorization: Bearer <api token>'.");
    await enforceRate(`api:${actor.userId}`, 600, 60, "API rate limit reached (600 requests per minute).");
    if (method !== "GET" && actor.via === "session") assertSameOrigin(req);

    const ctx: RouteCtx = { actor, params, req };
    if (def.access === "agency") ctx.org = await requireOrgAdmin(actor);
    else if (def.access !== "user") ctx.ws = await requireWorkspace(actor, params.ws, def.access.workspace);
    else ctx.org = (await primaryOrg(actor)) ?? undefined;

    let body: unknown = undefined;
    if (def.body) {
      let json: unknown;
      try { json = await req.json(); } catch { throw new AppError("VALIDATION_ERROR", "Request body must be JSON."); }
      const r = def.body.safeParse(json);
      if (!r.success) throw new AppError("VALIDATION_ERROR", "Invalid request body.", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
      body = r.data;
    }
    let query: unknown = undefined;
    if (def.query) {
      const r = def.query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!r.success) throw new AppError("VALIDATION_ERROR", "Invalid query parameters.", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
      query = r.data;
    }
    const data = await def.handler(ctx, { body, query });
    if (data instanceof Response) return data;
    return Response.json({ success: true, data });
  } catch (err) {
    const { body, status } = toFailure(err);
    if (status >= 500) log.error("api error", { path, method, err });
    return Response.json(body, { status });
  }
}

/** Cookie-authenticated writes must come from our own origin (CSRF defence; API tokens are exempt). */
function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (new URL(origin).host !== host) throw new AppError("FORBIDDEN", "Cross-origin request refused.");
}

/* ── OpenAPI ──────────────────────────────────────────────────────────── */

export function openApiDocument(baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  const schema = (t?: z.ZodType) => { if (!t) return undefined; try { return z.toJSONSchema(t, { unrepresentable: "any", io: "input" }); } catch { return {}; } };
  for (const r of routes) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const q = r.query ? schema(r.query) as { properties?: Record<string, unknown> } : undefined;
    for (const [name, s] of Object.entries(q?.properties ?? {})) params.push({ name, in: "query", required: false, schema: s as { type: string } });
    (paths[r.path] ??= {})[r.method.toLowerCase()] = {
      summary: r.summary, tags: [r.tag],
      description: r.access === "agency" ? "Requires an agency administrator." : r.access === "user" ? "Any authenticated user." : `Requires workspace permission: ${r.access.workspace}.`,
      parameters: params,
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(r.body) } } } } : {}),
      ...(r.rawBody ? { requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } } } : {}),
      responses: {
        200: { description: "Success envelope { success: true, data }", content: { "application/json": { schema: { type: "object", properties: { success: { const: true }, data: schema(r.response) ?? {} } } } } },
        "4XX": { description: "Error envelope { success: false, error: { code, message, details? } }" },
      },
      security: [{ bearer: [] }, { session: [] }],
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Cutline API", version: "1.0.0", description: "Authenticated API for client workspaces, the agent workflow and the blueprint system. All responses use the { success, data | error } envelope." },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Personal API token (Settings → API tokens)." }, session: { type: "apiKey", in: "cookie", name: "cl_session" } } },
    paths,
  };
}
