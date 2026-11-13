import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { connectWithApiKey, ConnectError, disconnect, replaceApiKey } from "../connections.service";
import { openCredentials } from "../credentials";
import { createFixtureTransport, type FixtureInteraction } from "../fixture-transport";

/**
 * CONNECTOR-LIVE.md, B1 finding 3: a connected key-based integration can take a new key in place.
 * The new key is validated with the provider first; only an accepted key replaces the stored one,
 * keeping the integration (id, connectedAt, settings, webhook secret, synced records). A refused
 * key changes nothing. Admin only, audited without any key value.
 */
const OLD = "rk_test_old_key_AAAA";
const NEW = "rk_test_new_key_BBBB";
const WRONG = "rk_test_wrong_key_CCC";

/** Stripe answers per key: OLD and NEW are accepted, WRONG is refused with 401. */
const customers = (key: string, status: number, body: unknown): FixtureInteraction => ({
  request: { method: "GET", path: "/v1/customers", headers: { authorization: `Bearer ${key}` } },
  response: { status, headers: {}, body },
});
const stripeWorld = (): FixtureInteraction[] => [
  customers(OLD, 200, { object: "list", data: [], has_more: false }),
  customers(NEW, 200, { object: "list", data: [], has_more: false }),
  customers(WRONG, 401, { error: { message: "Invalid API Key" } }),
];

async function connectedStripe(label: string) {
  const { actor } = await createTestAdmin(label);
  const transport = createFixtureTransport(stripeWorld());
  const deps = { transport: () => transport };
  const { integrationId } = await connectWithApiKey(
    actor,
    "STRIPE",
    { apiKey: OLD, webhookSecret: "whsec_keep_me_123" },
    deps,
  );
  const db = scopedDb(actor);
  // A synced record that must survive the key change.
  const account = await db.account.create({
    data: {
      workspaceId: actor.workspaceId,
      name: "Proof Alpha",
      domain: "proof-alpha.test",
      tier: "LONG_TAIL",
    },
  });
  await db.subscription.create({
    data: {
      workspaceId: actor.workspaceId,
      accountId: account.id,
      plan: "PROOF Plan",
      interval: "MONTH",
      amountMinor: 36_000n,
      quantity: 3,
      source: "STRIPE",
    },
  });
  return { actor, integrationId, transport, deps, db };
}

const row = (db: ReturnType<typeof scopedDb>, id: string) =>
  db.integration.findUniqueOrThrow({ where: { id } });

describe("replace the key of a connected integration", () => {
  it("validates the new key with the provider, then swaps it in place", async () => {
    const { actor, integrationId, transport, deps, db } = await connectedStripe("rk-ok");
    const before = await row(db, integrationId);
    transport.calls.length = 0;

    const r = await replaceApiKey(actor, integrationId, { apiKey: NEW }, deps);

    expect(r.check?.ok).toBe(true);
    expect(transport.calls[0]?.headers?.authorization).toBe(`Bearer ${NEW}`);
    const after = await row(db, integrationId);
    expect(after.id).toBe(before.id);
    expect(after.connectedAt).toEqual(before.connectedAt);
    expect(after.status).toBe("CONNECTED");
    expect(after.lastErrorPlain).toBeNull();
    expect(openCredentials(after.credentialsEnc)).toEqual({
      apiKey: NEW,
      webhookSecret: "whsec_keep_me_123",
    });
    expect(await db.subscription.count()).toBe(1);
    expect(await db.account.count()).toBe(1);
  });

  it("clears a 'rejected the saved credentials' error once a good key is in", async () => {
    const { actor, integrationId, deps, db } = await connectedStripe("rk-error");
    await db.integration.update({
      where: { id: integrationId },
      data: { status: "ERROR", lastErrorPlain: "Stripe rejected the saved credentials." },
    });
    await replaceApiKey(actor, integrationId, { apiKey: NEW }, deps);
    const after = await row(db, integrationId);
    expect(after.status).toBe("CONNECTED");
    expect(after.lastErrorPlain).toBeNull();
  });

  it("keeps the old key and changes nothing when the provider refuses the new one", async () => {
    const { actor, integrationId, deps, db } = await connectedStripe("rk-refused");
    const before = await row(db, integrationId);
    await expect(replaceApiKey(actor, integrationId, { apiKey: WRONG }, deps)).rejects.toThrow(
      /Stripe rejected/,
    );
    const after = await row(db, integrationId);
    expect(after.credentialsEnc).toBe(before.credentialsEnc);
    expect(after.status).toBe(before.status);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("audits the change and the refusal without any key value", async () => {
    const { actor, integrationId, deps } = await connectedStripe("rk-audit");
    await replaceApiKey(actor, integrationId, { apiKey: NEW }, deps);
    await replaceApiKey(actor, integrationId, { apiKey: WRONG }, deps).catch(() => null);
    const audits = await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${actor.workspaceId}, true)`;
      return tx.auditLog.findMany({
        where: { action: { in: ["integration.key_replaced", "integration.key_replace_failed"] } },
      });
    });
    expect(audits.map((a) => a.action).sort()).toEqual([
      "integration.key_replace_failed",
      "integration.key_replaced",
    ]);
    const text = JSON.stringify(audits);
    for (const k of [OLD, NEW, WRONG]) expect(text).not.toContain(k);
  });

  it("refuses a disconnected integration and a non-admin", async () => {
    const { actor, integrationId, deps } = await connectedStripe("rk-refuse");
    await expect(
      replaceApiKey({ ...actor, role: "CSM" }, integrationId, { apiKey: NEW }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await disconnect(actor, integrationId);
    await expect(replaceApiKey(actor, integrationId, { apiKey: NEW }, deps)).rejects.toBeInstanceOf(
      ConnectError,
    );
  });

  it("refuses an integration from another workspace", async () => {
    const { integrationId, deps } = await connectedStripe("rk-owner");
    const { actor: other } = await createTestAdmin("rk-other");
    await expect(replaceApiKey(other, integrationId, { apiKey: NEW }, deps)).rejects.toBeInstanceOf(
      ConnectError,
    );
  });
});
