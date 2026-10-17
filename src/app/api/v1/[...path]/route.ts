import { dispatch, openApiDocument } from "@/server/api/registry";
import "@/server/api/routes";
import { env } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const p = `/${path.join("/")}`;
  if (req.method === "GET" && p === "/openapi.json") return Response.json(openApiDocument(env.appUrl()));
  return dispatch(req, p);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
