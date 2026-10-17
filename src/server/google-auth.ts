import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { notConfigured } from "@/lib/errors";
import { env } from "./env";
import { ReauthRequired, refreshAccessToken, type OAuthTokens } from "./providers/youtube";
import { readCredential, updateCredential } from "./secrets";

type GoogleConnection = Pick<typeof connections.$inferSelect, "id" | "credentialId" | "label">;

/**
 * A valid access token for any Google OAuth connection (YouTube or Drive),
 * refreshed when it is about to expire. A revoked grant marks the connection
 * as needing attention instead of failing silently.
 */
export async function googleAccessToken(c: GoogleConnection, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!c.credentialId) throw notConfigured(`${c.label} has no stored authorisation. Reconnect it.`);
  const tokens = await readCredential<OAuthTokens>(c.credentialId);
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  const google = env.google();
  if (!google) throw notConfigured("Google OAuth is not configured on this installation (GOOGLE_OAUTH_CLIENT_ID / SECRET).");
  if (!tokens.refresh_token) throw new ReauthRequired();
  try {
    const next = await refreshAccessToken({ clientId: google.clientId, clientSecret: google.clientSecret, refreshToken: tokens.refresh_token }, fetchImpl);
    await updateCredential(db, c.credentialId, { ...tokens, ...next });
    return next.access_token;
  } catch (err) {
    if (err instanceof ReauthRequired) await db.update(connections).set({ status: "error", lastError: err.message }).where(eq(connections.id, c.id));
    throw err;
  }
}
