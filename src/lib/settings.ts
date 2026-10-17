import { z } from "zod";

/** Per-workspace (per-client) settings. Stored in workspaces.settings; always read through parse(). */
export const workspaceSettingsSchema = z.object({
  /** Allow this workspace to fall back to agency-shared AI providers when it has none of its own. */
  allowAgencyProviders: z.boolean().default(true),
  limits: z.object({
    maxUploadMb: z.number().int().min(10).max(51_200).default(8192),
    monthlyRenderMinutes: z.number().int().min(0).max(100_000).default(600),
    monthlyTranscriptionMinutes: z.number().int().min(0).max(100_000).default(600),
    monthlyLlmCalls: z.number().int().min(0).max(1_000_000).default(500),
  }).strict().prefault({}),
  retention: z.object({
    /** Renders and working copies older than this are deleted. 0 = keep forever. */
    renderDays: z.number().int().min(0).max(3650).default(90),
    /** Original footage is kept unless this is set. 0 = keep forever. */
    sourceDays: z.number().int().min(0).max(3650).default(0),
  }).strict().prefault({}),
  /**
   * Standing authorisation for rule-based publishing. Only a workspace owner
   * can turn this on; it is audit-logged and revocable.
   */
  autoPublishAuthorized: z.boolean().default(false),
}).strict();

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const r = workspaceSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : workspaceSettingsSchema.parse({});
}

export const orgSettingsSchema = z.object({
  defaultTimezone: z.string().default("UTC"),
  /** New workspaces start from these limits. */
  defaultLimits: workspaceSettingsSchema.shape.limits,
  security: z.object({
    sessionDays: z.number().int().min(1).max(90).default(14),
    requireApprovalForPublishing: z.boolean().default(true),
  }).strict().prefault({}),
}).strict();

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export function parseOrgSettings(raw: unknown): OrgSettings {
  const r = orgSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : orgSettingsSchema.parse({});
}
