import "server-only";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { AppError } from "@/lib/errors";
import { requireActor } from "../auth";
import { log } from "../logger";
import { requireOrgAdmin, requireWorkspace, type Permission } from "../tenancy";

/** Runs an action body and converts any failure into form feedback. Never leaks internals. */
export async function act(fn: () => Promise<string | ActionState | void>): Promise<ActionState> {
  try {
    const r = await fn();
    if (typeof r === "string") return { ok: true, message: r, at: Date.now() };
    return { ok: true, ...(r ?? {}), at: Date.now() };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof AppError) {
      const details = err.details as { errors?: string[]; checks?: { label: string; message: string }[] } | undefined;
      const extra = details?.errors?.length ? ` ${details.errors.slice(0, 3).join(" ")}` : details?.checks?.length ? ` ${details.checks.map((c) => `${c.label}: ${c.message}`).join(" · ")}` : "";
      return { ok: false, error: `${err.message}${err.message.includes(extra.trim()) ? "" : extra}`.trim(), at: Date.now() };
    }
    if (err instanceof z.ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const i of err.issues) fieldErrors[String(i.path[0] ?? "form")] ??= i.message;
      return { ok: false, error: err.issues[0]?.message ?? "Please check the form.", fieldErrors, at: Date.now() };
    }
    log.error("action failed", { err });
    return { ok: false, error: "Something went wrong. Please try again.", at: Date.now() };
  }
}

export async function wsCtx(fd: FormData | string, permission: Permission) {
  const actor = await requireActor();
  const id = typeof fd === "string" ? fd : String(fd.get("ws") ?? "");
  return requireWorkspace(actor, id, permission);
}

export async function orgCtx() {
  return requireOrgAdmin(await requireActor());
}

export const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
export const list = (fd: FormData, k: string) => str(fd, k).split(/\n|,/).map((x) => x.trim()).filter(Boolean);
export const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
export const num = (fd: FormData, k: string): number | null => { const v = str(fd, k); return v === "" ? null : Number(v); };
