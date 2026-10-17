import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { getActor } from "@/server/auth";
import { completeYouTubeOAuth } from "@/server/services/integrations";
import { safeInternalPath } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Google redirects here after consent. The state is verified against the signed-in user who started the flow. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const actor = await getActor();
  if (!actor) redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error || !code) redirect(`/oauth-result?error=${encodeURIComponent(error === "access_denied" ? "You declined access on Google's consent screen." : "Google did not return an authorisation code.")}`);
  let target: string;
  try {
    const r = await completeYouTubeOAuth(actor.userId, state, code);
    target = `${safeInternalPath(r.returnTo, `/w/${r.workspaceId}/integrations`)}${r.returnTo.includes("?") ? "&" : "?"}connected=${encodeURIComponent(r.channelTitle)}`;
  } catch (e) {
    target = `/oauth-result?error=${encodeURIComponent(e instanceof AppError ? e.message : "The YouTube connection could not be completed.")}`;
  }
  redirect(target);
}
