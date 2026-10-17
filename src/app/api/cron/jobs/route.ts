import { scheduleTick } from "@/server/jobs/handlers";
import { runInline } from "@/server/jobs/inline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron entry point: queues scheduled work (retention, scheduled
 * workflows, channel refreshes) and drains the queue. Requires
 * `Authorization: Bearer $CRON_SECRET`, which Vercel sends automatically.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  await scheduleTick();
  const processed = await runInline(270_000);
  return Response.json({ ok: true, processed });
}
