import "server-only";
import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { agentDeployments, blueprintVersions } from "@/db/schema";
import { defaultAgentConfig } from "@/lib/blueprint/defaults";
import { deepMerge } from "@/lib/blueprint/diff";
import { configConsistency } from "@/lib/blueprint/package";
import { agentConfigSchema, blueprintSchema, type AgentConfig } from "@/lib/blueprint/schema";
import { validationError } from "@/lib/errors";
import type { WorkspaceCtx } from "../tenancy";

export type Deployment = typeof agentDeployments.$inferSelect;

/** Blueprint defaults + this client's overrides, validated as a whole. */
export function mergeConfig(base: AgentConfig, overrides: unknown): AgentConfig {
  const merged = agentConfigSchema.safeParse(deepMerge(structuredClone(base), overrides ?? {}));
  if (!merged.success) throw validationError(`Invalid configuration: ${merged.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const problems = configConsistency(merged.data);
  if (problems.length) throw validationError(problems.join(" "));
  return merged.data;
}

/**
 * The configuration the agent uses for this workspace. With a deployment it
 * is the pinned blueprint version plus the client's overrides; without one,
 * the starter defaults (manual features still work, workflows do not run).
 */
export async function effectiveConfig(ws: Pick<WorkspaceCtx, "workspaceId">, conn: DbOrTx = db): Promise<{ config: AgentConfig; deployment: Deployment | null }> {
  const [row] = await conn.select({ d: agentDeployments, content: blueprintVersions.content }).from(agentDeployments)
    .innerJoin(blueprintVersions, eq(blueprintVersions.id, agentDeployments.blueprintVersionId))
    .where(eq(agentDeployments.workspaceId, ws.workspaceId)).limit(1);
  if (!row) return { config: defaultAgentConfig(), deployment: null };
  const bp = blueprintSchema.parse(row.content);
  return { config: mergeConfig(bp.config, row.d.overrides), deployment: row.d };
}
