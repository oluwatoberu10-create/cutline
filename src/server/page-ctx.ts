import "server-only";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { AppError } from "@/lib/errors";
import { pageActor } from "./auth";
import { requireWorkspace, type Permission, type WorkspaceCtx } from "./tenancy";

/**
 * Workspace context for a page. A workspace the user may not open renders as
 * 404 (the same as one that does not exist); missing permission for a page
 * that needs more than "view" sends them to the workspace overview.
 */
export const pageWs = cache(async (wsId: string, permission: Permission = "view"): Promise<WorkspaceCtx> => {
  const actor = await pageActor();
  try {
    return await requireWorkspace(actor, wsId, permission);
  } catch (e) {
    if (e instanceof AppError && e.code === "FORBIDDEN") redirect(`/w/${wsId}?denied=1`);
    notFound();
  }
});

/** Agency context for a page; anyone who is not an agency admin is sent home. */
export const pageOrg = cache(async () => {
  const actor = await pageActor();
  const { primaryOrg } = await import("./tenancy");
  const org = await primaryOrg(actor);
  if (!org?.isAdmin) redirect("/");
  return org;
});
