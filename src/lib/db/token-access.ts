import type { PortalAccess, Prisma } from "@prisma/client";
import { rawDb } from "./raw";

/**
 * Token-holder access for the two public, sessionless M10 paths (customer portal, survey link).
 * Like `inbound.ts`: the request carries a token, one transaction-local setting lets a read-only
 * RLS policy admit exactly the row the token names, and everything after runs inside one
 * workspace. Moved here from the portal and survey services (M11 housekeeping) so raw client use
 * and raw SQL stay inside src/lib/db; the SQL and settings are unchanged.
 */

/** The PortalAccess row whose stored SHA-256 hash equals `tokenHash`, or null. */
export async function findPortalAccessByTokenHash(tokenHash: string): Promise<PortalAccess | null> {
  const [, access] = await rawDb.$transaction([
    rawDb.$executeRaw`SELECT set_config('app.portal_token_hash', ${tokenHash}, true)`,
    rawDb.portalAccess.findFirst({ where: { tokenHash } }),
  ]);
  return access;
}

/**
 * Runs `fn` in one transaction scoped to `workspaceId` with the survey token visible to the
 * survey-token RLS policy. The caller has already verified the token's signature, and the
 * workspace id comes from that signed token.
 */
export function withSurveyTokenSession<T>(
  workspaceId: string,
  token: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.survey_token', ${token}, true)`;
    return fn(tx);
  });
}
