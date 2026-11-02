import { describe, expect, it } from "vitest";
import { createAuthAdapter } from "@/lib/auth/adapter";
import { fieldCipher } from "@/lib/crypto";
import { rawDb } from "@/lib/db/raw";
import { createTestWorkspace } from "@/test/fixtures";

/** D-08: linked OAuth accounts live in AuthAccount, with tokens encrypted at rest. */
describe("Auth.js adapter", () => {
  const adapter = createAuthAdapter();

  it("links, finds and unlinks accounts through AuthAccount with encrypted tokens", async () => {
    const { user } = await createTestWorkspace("Adapter");
    const providerAccountId = `google-${user.id}`;
    await adapter.linkAccount!({
      userId: user.id,
      type: "oidc",
      provider: "google",
      providerAccountId,
      access_token: "plain-access-token",
      refresh_token: "plain-refresh-token",
      id_token: "plain-id-token",
      token_type: "bearer",
    });

    const stored = await rawDb.authAccount.findUniqueOrThrow({
      where: { provider_providerAccountId: { provider: "google", providerAccountId } },
    });
    for (const [field, plain] of [
      ["access_token", "plain-access-token"],
      ["refresh_token", "plain-refresh-token"],
      ["id_token", "plain-id-token"],
    ] as const) {
      expect(stored[field]).not.toBe(plain);
      expect(fieldCipher().decrypt(stored[field]!)).toBe(plain);
    }

    const found = await adapter.getUserByAccount!({ provider: "google", providerAccountId });
    expect(found?.id).toBe(user.id);

    await adapter.unlinkAccount!({ provider: "google", providerAccountId });
    expect(await adapter.getUserByAccount!({ provider: "google", providerAccountId })).toBeNull();
  });

  it("normalises emails to lower case", async () => {
    const created = await adapter.createUser!({
      id: "ignored",
      email: `Mixed.Case.${Date.now()}@Example.TEST`,
      emailVerified: null,
    });
    expect(created.email).toBe(created.email.toLowerCase());
    expect(await adapter.getUserByEmail!(created.email.toUpperCase())).toMatchObject({
      id: created.id,
    });
  });
});
