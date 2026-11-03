import { z } from "zod";
import { fieldCipher } from "@/lib/crypto";

/**
 * Integration credentials, sealed as one AES-256-GCM blob in Integration.credentialsEnc
 * (ARCHITECTURE §7.5, Rule 9). Plain values exist only in memory inside this module's callers;
 * they are never logged, returned to the client, or written to fixtures.
 */
export const credentialsSchema = z.object({
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  /** ISO instant the access token stops working. */
  expiresAt: z.string().optional(),
  /** Salesforce: the org's API host. */
  instanceUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  /** Chargebee: the site name (`<site>.chargebee.com`). */
  site: z
    .string()
    .regex(/^[a-z0-9-]{1,63}$/)
    .optional(),
  /** Per-integration webhook secret (D3). Chargebee: "user:password" for Basic auth. */
  webhookSecret: z.string().min(1).optional(),
});

export type Credentials = z.infer<typeof credentialsSchema>;

export function sealCredentials(c: Credentials): string {
  return fieldCipher().encrypt(JSON.stringify(credentialsSchema.parse(c)));
}

export function openCredentials(sealed: string | null): Credentials {
  if (!sealed) return {};
  return credentialsSchema.parse(JSON.parse(fieldCipher().decrypt(sealed)));
}

/** True when the access token is missing or expires within `skewMs`. */
export function needsRefresh(c: Credentials, now: Date, skewMs = 60_000): boolean {
  if (!c.accessToken) return true;
  if (!c.expiresAt) return false;
  return new Date(c.expiresAt).getTime() - skewMs <= now.getTime();
}
