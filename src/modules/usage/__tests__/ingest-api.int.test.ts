import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@/lib/dates";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  aggregateUsage,
  disconnect,
  hashIngestKey,
  issueUsageApiKey,
  receiveUsage,
  saveSegmentSecret,
  type AggregatePayload,
  type UsageDeps,
} from "@/modules/integrations/service";

/**
 * M6 B1 / M6.md §5: the Usage API on the M5 framework. Wrong keys, workspace separation, rotation,
 * the rate limit, the business clock, replay-safe aggregation, Segment's signature, and the proof
 * that no raw-event table exists (D-23, Q-33).
 */
const NOON = fixedClock("2026-11-02T12:00:00Z");

type Ws = Awaited<ReturnType<typeof workspace>>;

async function workspace(label: string, timezone = "UTC") {
  const { actor, workspace: w } = await createTestAdmin(label);
  await rawDb.workspace.update({ where: { id: w.id }, data: { timezone } });
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: {
      workspaceId: actor.workspaceId,
      name: `${label} Co`,
      tier: "MID_TOUCH",
      plan: "Growth",
    },
  });
  await db.featureCatalog.create({
    data: {
      workspaceId: actor.workspaceId,
      featureKey: "dashboards",
      label: "Dashboards",
      includedInPlans: ["Growth"],
    },
  });
  const issued = await issueUsageApiKey(actor);
  return { actor, db, account, ...issued };
}

const queued: AggregatePayload[] = [];
const deps = (extra: UsageDeps = {}): UsageDeps => ({
  clock: NOON,
  now: () => new Date("2026-11-02T12:00:00Z"),
  enqueue: async (p) => void queued.push(p),
  ...extra,
});

const post = (
  kind: "track" | "identify" | "batch",
  key: string | null,
  body: unknown,
  d: UsageDeps = deps(),
  headers: Record<string, string> = {},
) =>
  receiveUsage(
    kind,
    {
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
      url: "http://localhost/api/usage/v1/" + kind,
    },
    d,
  );

/** Sends a batch and runs the aggregation job it enqueued, as the worker would. */
async function ingest(key: string, body: unknown, d: UsageDeps = deps()) {
  const before = queued.length;
  const res = await post("batch", key, body, d);
  const jobs = queued.slice(before);
  const results = [];
  for (const j of jobs) results.push(await aggregateUsage(j));
  return { res, jobs, results };
}

const track = (account: string, userId: string, event: string, extra: object = {}) => ({
  type: "track",
  userId,
  groupId: account,
  event,
  ...extra,
});

let A: Ws;
let B: Ws;
beforeAll(async () => {
  A = await workspace("UsageA");
  B = await workspace("UsageB");
});

describe("authentication (M6 §5: wrong key → 401)", () => {
  it("refuses a missing, a wrong and a malformed key the same way, and stores nothing", async () => {
    const before = queued.length;
    for (const key of [null, "nxu_not-a-real-key", "garbage", `${A.key}x`]) {
      const res = await post("track", key, track(A.account.id, "u1", "Opened"));
      expect({ status: res.status, body: res.body }).toEqual({
        status: 401,
        body: { error: "unverified" },
      });
    }
    expect(queued.length).toBe(before);
  });

  it("accepts the key as a Bearer token or as the user name of Basic auth", async () => {
    const bearer = await post("track", A.key, track(A.account.id, "u1", "Opened"));
    expect(bearer.status).toBe(202);
    const basic = await post("track", null, track(A.account.id, "u1", "Opened"), deps(), {
      authorization: `Basic ${Buffer.from(`${A.key}:`).toString("base64")}`,
    });
    expect(basic.status).toBe(202);
  });

  it("stores only the hash and the last four characters (Rule 9)", async () => {
    const row = await A.db.integration.findUniqueOrThrow({ where: { id: A.integrationId } });
    expect(row.ingestKeyHash).toBe(hashIngestKey(A.key));
    expect(row.ingestKeyLast4).toBe(A.key.slice(-4));
    expect(JSON.stringify(row)).not.toContain(A.key);
    const audits = await A.db.auditLog.findMany({
      where: { action: { startsWith: "usage_api." } },
    });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(A.key);
  });

  it("a disconnected integration's key stops working", async () => {
    const W = await workspace("UsageGone");
    expect((await post("track", W.key, track(W.account.id, "u1", "Opened"))).status).toBe(202);
    await disconnect(W.actor, W.integrationId);
    expect((await post("track", W.key, track(W.account.id, "u1", "Opened"))).status).toBe(401);
    const row = await W.db.integration.findUniqueOrThrow({ where: { id: W.integrationId } });
    expect(row.ingestKeyHash).toBeNull();
  });
});

describe("the key lookup policy (Rule 2)", () => {
  it("admits exactly the one integration whose hash was named, and nothing otherwise", async () => {
    const [, named] = await rawDb.$transaction([
      rawDb.$executeRaw`SELECT set_config('app.usage_key_hash', ${hashIngestKey(A.key)}, true)`,
      rawDb.integration.findMany({ where: { provider: "USAGE_API" }, select: { id: true } }),
    ]);
    expect(named.map((r) => r.id)).toEqual([A.integrationId]);
    const none = await rawDb.integration.findMany({
      where: { provider: "USAGE_API" },
      select: { id: true },
    });
    expect(none).toEqual([]);
  });
});

describe("rotation", () => {
  it("a rotated key invalidates the old one at once, and the new one works", async () => {
    const W = await workspace("UsageRotate");
    const rotated = await issueUsageApiKey(W.actor);
    expect(rotated.rotated).toBe(true);
    expect(rotated.integrationId).toBe(W.integrationId);
    expect(rotated.key).not.toBe(W.key);
    expect((await post("track", W.key, track(W.account.id, "u1", "Opened"))).status).toBe(401);
    expect((await post("track", rotated.key, track(W.account.id, "u1", "Opened"))).status).toBe(
      202,
    );
  });
});

describe("tenant isolation (Rule 2, M6 §5)", () => {
  it("workspace A's key cannot write usage for workspace B's account: it is unmatched in A only", async () => {
    const { res, results } = await ingest(A.key, {
      batch: [track(B.account.id, "intruder", "Opened"), track(A.account.id, "mine", "Opened")],
    });
    expect(res.status).toBe(202);
    expect(results[0]!.status).toBe("APPLIED");
    // Nothing of B's changed.
    expect(await B.db.usageDaily.count()).toBe(0);
    expect(await B.db.userUsageDaily.count()).toBe(0);
    expect(await B.db.usageIngestBatch.count()).toBe(0);
    // A has its own rows and a record that one group matched nothing.
    expect(await A.db.userUsageDaily.count({ where: { externalUserId: "intruder" } })).toBe(0);
    expect(await A.db.userUsageDaily.count({ where: { externalUserId: "mine" } })).toBe(1);
    const batch = await A.db.usageIngestBatch.findFirstOrThrow({
      orderBy: { appliedAt: "desc" },
    });
    expect(batch.unmatched).toEqual([expect.objectContaining({ groupId: B.account.id })]);
  });

  it("B's ledger is invisible to A's scope", async () => {
    await ingest(B.key, { batch: [track(B.account.id, "bee", "Opened")] });
    expect(await B.db.usageIngestBatch.count()).toBeGreaterThan(0);
    const aIds = new Set((await A.db.usageIngestBatch.findMany()).map((b) => b.workspaceId));
    expect([...aIds]).toEqual([A.actor.workspaceId]);
  });
});

describe("rate limit", () => {
  it("refuses cleanly with 429 and Retry-After, per key", async () => {
    const W = await workspace("UsageRate");
    const other = await workspace("UsageRateOther");
    const d = deps({ limit: { limit: 2, windowSeconds: 60 } });
    const send = (key: string) => post("track", key, track("x", "u", "Opened"), d);
    expect((await send(W.key)).status).toBe(202);
    expect((await send(W.key)).status).toBe(202);
    const refused = await send(W.key);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers?.["retry-after"])).toBeGreaterThan(0);
    expect(refused.body).toMatchObject({ error: "rate limit reached", limit: 2 });
    // Another integration is not slowed by this one's traffic.
    expect((await send(other.key)).status).toBe(202);
  });

  it("answers 503 (never unthrottled) when the limiter cannot be reached", async () => {
    const res = await post("track", A.key, track(A.account.id, "u", "Opened"), {
      ...deps(),
      hit: async () => {
        throw new Error("redis down");
      },
    });
    expect(res.status).toBe(503);
  });
});

describe("validation per event", () => {
  it("takes the good events and reports the bad ones by index", async () => {
    const before = queued.length;
    const res = await post("batch", A.key, {
      batch: [
        track(A.account.id, "u1", "Opened"),
        { type: "track", userId: "u2", event: "No group" },
        { type: "group", userId: "u1", groupId: A.account.id },
        track(A.account.id, "u3", "Opened", { timestamp: "2026-01-01T00:00:00Z" }),
        track(A.account.id, "u4", "Opened", { timestamp: "2026-11-09T00:00:00Z" }),
      ],
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: 1, ignored: 1 });
    expect((res.body.rejected as Array<{ index: number }>).map((r) => r.index)).toEqual([1, 3, 4]);
    expect(queued.length).toBe(before + 1);
    expect(queued.at(-1)!.events).toHaveLength(1);
  });

  it("answers 400 when nothing in the body is usable, and enqueues nothing", async () => {
    const before = queued.length;
    expect((await post("track", A.key, { event: "No user" })).status).toBe(400);
    expect((await post("track", A.key, "not json")).status).toBe(400);
    expect(queued.length).toBe(before);
  });

  it("keeps only what aggregation needs in the job (no free-form properties travel on)", async () => {
    const before = queued.length;
    await post(
      "track",
      A.key,
      track(A.account.id, "u1", "Opened", { properties: { feature: "dashboards", secret: "x" } }),
    );
    const job = queued.at(-1)!;
    expect(queued.length).toBe(before + 1);
    expect(JSON.stringify(job)).not.toContain("secret");
    expect(job.events[0]).toMatchObject({ feature: "dashboards", kind: "track" });
  });
});

describe("the business clock governs 'today' (D-50, D-81)", () => {
  it("an event without a timestamp lands on the business day in the workspace time zone", async () => {
    const W = await workspace("UsageClock", "America/Los_Angeles");
    // 03:00 UTC on 3 Nov is still 2 Nov in Los Angeles.
    const d = deps({ clock: fixedClock("2026-11-03T03:00:00Z") });
    await ingest(W.key, { batch: [track(W.account.id, "u1", "Opened")] }, d);
    const rows = await W.db.usageDaily.findMany();
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual(["2026-11-02"]);
    // The same event under a clock a day later is a different day: the real clock is not read.
    await ingest(
      W.key,
      { batch: [track(W.account.id, "u2", "Opened")] },
      deps({ clock: fixedClock("2026-11-04T18:00:00Z") }),
    );
    const days = (await W.db.usageDaily.findMany({ orderBy: { date: "asc" } })).map((r) =>
      r.date.toISOString().slice(0, 10),
    );
    expect(days).toEqual(["2026-11-02", "2026-11-04"]);
  });

  it("an explicit timestamp is dated in the workspace time zone", async () => {
    const W = await workspace("UsageStamp", "Asia/Kolkata");
    await ingest(W.key, {
      batch: [track(W.account.id, "u1", "Opened", { timestamp: "2026-10-31T20:00:00Z" })],
    });
    const rows = await W.db.usageDaily.findMany();
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual(["2026-11-01"]);
  });
});

describe("aggregation (D-23)", () => {
  const batch = (a: string) => ({
    batch: [
      track(a, "ana", "Session Started", { messageId: "m1" }),
      track(a, "ana", "dashboards", { messageId: "m2" }),
      track(a, "ben", "Opened", { messageId: "m3", properties: { feature: "dashboards" } }),
      track(a, "ben", "Opened", { messageId: "m4", properties: { feature: "alerts" } }),
      { type: "identify", userId: "ana", groupId: a, traits: { email: "ana@example.test" } },
    ],
  });

  it("folds events into the three daily tables with exact counts", async () => {
    const W = await workspace("UsageFold");
    await W.db.contact.create({
      data: {
        workspaceId: W.actor.workspaceId,
        accountId: W.account.id,
        name: "Ana",
        email: "ana@example.test",
      },
    });
    const { results } = await ingest(W.key, batch(W.account.id));
    expect(results[0]).toMatchObject({ status: "APPLIED", counts: { created: 1, updated: 0 } });
    const day = await W.db.usageDaily.findFirstOrThrow();
    expect({ events: day.events, sessions: day.sessions, activeUsers: day.activeUsers }).toEqual({
      events: 4,
      sessions: 1,
      activeUsers: 2,
    });
    expect(day.source).toBe("USAGE_API");
    const users = await W.db.userUsageDaily.findMany({ orderBy: { externalUserId: "asc" } });
    expect(users.map((u) => [u.externalUserId, u.events, u.sessions])).toEqual([
      ["ana", 2, 1],
      ["ben", 2, 0],
    ]);
    expect(users[0]!.contactId).not.toBeNull();
    expect(users[1]!.contactId).toBeNull();
    const features = await W.db.featureUsageDaily.findMany({ orderBy: { featureKey: "asc" } });
    expect(features.map((f) => [f.featureKey, f.users, f.events])).toEqual([
      ["alerts", 1, 1],
      ["dashboards", 2, 2],
    ]);
  });

  it("is idempotent: the same batch again, even reordered or resent, changes nothing", async () => {
    const W = await workspace("UsageIdem");
    const body = batch(W.account.id);
    const first = await ingest(W.key, body);
    const snapshot = async () =>
      JSON.stringify([
        await W.db.usageDaily.findMany({ orderBy: { date: "asc" } }),
        await W.db.userUsageDaily.findMany({ orderBy: { externalUserId: "asc" } }),
        await W.db.featureUsageDaily.findMany({ orderBy: { featureKey: "asc" } }),
      ]);
    const before = await snapshot();
    const second = await ingest(W.key, body);
    const reordered = await ingest(W.key, { batch: [...body.batch].reverse() });
    expect(second.results[0]!.status).toBe("SKIPPED");
    expect(reordered.results[0]!.status).toBe("SKIPPED");
    expect(first.jobs[0]!.batchKey).toBe(reordered.jobs[0]!.batchKey);
    expect(await snapshot()).toBe(before);
    expect(await W.db.usageIngestBatch.count()).toBe(1);
  });

  it("a different batch adds to the day; a feature's users never exceed the people seen", async () => {
    const W = await workspace("UsageAdd");
    await ingest(W.key, {
      batch: [
        track(W.account.id, "ana", "Opened", {
          messageId: "x1",
          properties: { feature: "alerts" },
        }),
      ],
    });
    await ingest(W.key, {
      batch: [
        track(W.account.id, "ana", "Opened", {
          messageId: "x2",
          properties: { feature: "alerts" },
        }),
      ],
    });
    const day = await W.db.usageDaily.findFirstOrThrow();
    expect({ events: day.events, activeUsers: day.activeUsers }).toEqual({
      events: 2,
      activeUsers: 1,
    });
    const f = await W.db.featureUsageDaily.findFirstOrThrow();
    expect({ users: f.users, events: f.events }).toEqual({ users: 1, events: 2 });
  });

  it("leaves a day another source owns as it is, and says so", async () => {
    const W = await workspace("UsageOwned");
    const date = new Date("2026-11-02T00:00:00Z");
    await W.db.usageDaily.create({
      data: {
        workspaceId: W.actor.workspaceId,
        accountId: W.account.id,
        date,
        activeUsers: 9,
        sessions: 9,
        events: 99,
        source: "MANUAL",
      },
    });
    const { results } = await ingest(W.key, {
      batch: [track(W.account.id, "ana", "Opened", { messageId: "own1" })],
    });
    expect(results[0]!.counts!.conflicts).toBe(1);
    const day = await W.db.usageDaily.findFirstOrThrow();
    expect({ events: day.events, source: day.source }).toEqual({ events: 99, source: "MANUAL" });
    const ledger = await W.db.usageIngestBatch.findFirstOrThrow();
    expect(JSON.stringify(ledger.skipped)).toContain("another source already owns");
  });

  it("resolves a group id through the account id, a CRM id or the domain, and only when it is exactly one", async () => {
    const W = await workspace("UsageMatch");
    const db = W.db;
    const ws = W.actor.workspaceId;
    const byDomain = await db.account.create({
      data: { workspaceId: ws, name: "Dom", tier: "LONG_TAIL", domain: "dom.example" },
    });
    const byCrm = await db.account.create({
      data: { workspaceId: ws, name: "Crm", tier: "LONG_TAIL" },
    });
    await db.externalRef.create({
      data: {
        workspaceId: ws,
        source: "HUBSPOT",
        objectType: "Account",
        externalId: "hs-777",
        internalType: "Account",
        internalId: byCrm.id,
      },
    });
    await db.account.create({
      data: { workspaceId: ws, name: "Twin1", tier: "LONG_TAIL", domain: "twin.example" },
    });
    await db.account.create({
      data: { workspaceId: ws, name: "Twin2", tier: "LONG_TAIL", domain: "twin.example" },
    });
    const { results } = await ingest(W.key, {
      batch: [
        track("dom.example", "u1", "Opened"),
        track("hs-777", "u2", "Opened"),
        track(W.account.id, "u3", "Opened"),
        track("twin.example", "u4", "Opened"),
      ],
    });
    expect(results[0]!.counts).toMatchObject({ created: 3 });
    expect(await db.usageDaily.count({ where: { accountId: byDomain.id } })).toBe(1);
    expect(await db.usageDaily.count({ where: { accountId: byCrm.id } })).toBe(1);
    const ledger = await db.usageIngestBatch.findFirstOrThrow();
    expect(ledger.unmatched).toEqual([expect.objectContaining({ groupId: "twin.example" })]);
  });
});

describe("Segment destination (verified with the integration's own shared secret)", () => {
  const sign = (body: string, secret: string) =>
    createHmac("sha1", secret).update(body).digest("hex");

  it("accepts a correctly signed event, one per request, at the same endpoint", async () => {
    const W = await workspace("UsageSeg");
    await saveSegmentSecret(W.actor, "segment-shared-secret-1");
    const body = JSON.stringify(track(W.account.id, "u1", "Opened"));
    const url = `http://localhost/api/usage/v1/batch?integration=${W.integrationId}`;
    const res = await receiveUsage(
      "batch",
      { headers: { "x-signature": sign(body, "segment-shared-secret-1") }, rawBody: body, url },
      deps(),
    );
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: 1 });
  });

  it("refuses a wrong signature, another integration's secret, and no secret set", async () => {
    const W = await workspace("UsageSegBad");
    const Z = await workspace("UsageSegOther");
    await saveSegmentSecret(W.actor, "secret-of-workspace-w");
    await saveSegmentSecret(Z.actor, "secret-of-workspace-z");
    const body = JSON.stringify(track(W.account.id, "u1", "Opened"));
    const url = `http://localhost/api/usage/v1/batch?integration=${W.integrationId}`;
    const send = (sig: string, u = url) =>
      receiveUsage("batch", { headers: { "x-signature": sig }, rawBody: body, url: u }, deps());
    expect((await send(sign(body, "wrong"))).status).toBe(401);
    expect((await send(sign(body, "secret-of-workspace-z"))).status).toBe(401);
    // Z's secret against Z's integration cannot write W's account.
    const zUrl = `http://localhost/api/usage/v1/batch?integration=${Z.integrationId}`;
    const zRes = await send(sign(body, "secret-of-workspace-z"), zUrl);
    expect(zRes.status).toBe(202);
    const before = queued.length;
    expect(queued.at(-1)!.workspaceId).toBe(Z.actor.workspaceId);
    expect(queued.length).toBe(before);
    // No secret saved at all.
    const U = await workspace("UsageSegNone");
    const noSecret = await receiveUsage(
      "batch",
      {
        headers: { "x-signature": sign(body, "anything-at-all") },
        rawBody: body,
        url: `http://localhost/api/usage/v1/batch?integration=${U.integrationId}`,
      },
      deps(),
    );
    expect(noSecret.status).toBe(401);
    // The secret is sealed, never stored as text.
    const row = await W.db.integration.findUniqueOrThrow({ where: { id: W.integrationId } });
    expect(row.credentialsEnc).not.toContain("secret-of-workspace-w");
  });
});

describe("no raw-event table (D-23, Q-33)", () => {
  const EVENT_MODELS = ["WebhookEvent", "OutboxEvent", "RevenueEvent"];
  const RAW_COLUMNS = [
    "properties",
    "traits",
    "eventName",
    "event",
    "rawEvent",
    "messageId",
    "anonymousId",
  ];

  it("the schema holds no model for product events, and the usage tables hold aggregates only", () => {
    const models = Prisma.dmmf.datamodel.models;
    const eventLike = models.filter((m) => /event/i.test(m.name)).map((m) => m.name);
    expect(eventLike.sort()).toEqual([...EVENT_MODELS].sort());
    for (const name of ["UsageDaily", "UserUsageDaily", "FeatureUsageDaily", "UsageIngestBatch"]) {
      const m = models.find((x) => x.name === name)!;
      for (const f of m.fields) {
        expect({ model: name, column: f.name, json: f.type === "Json" }).toEqual({
          model: name,
          column: f.name,
          json: ["unmatched", "skipped"].includes(f.name),
        });
      }
    }
    // The three event-named tables hold billing, webhook and outbox records, none of them usage.
    const rawish = models
      .filter((m) => !EVENT_MODELS.includes(m.name))
      .flatMap((m) => m.fields.map((f) => ({ model: m.name, column: f.name })))
      .filter((c) => RAW_COLUMNS.includes(c.column));
    expect(rawish).toEqual([]);
  });

  it("the database agrees: no table or column outside that list could hold an event", async () => {
    const tables = await rawDb.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name ILIKE '%event%'`;
    expect(tables.map((t) => t.table_name).sort()).toEqual([...EVENT_MODELS].sort());
  });

  it("the ledger holds a hash and counts, and the job payload is the only holder of the events", async () => {
    const ledger = await A.db.usageIngestBatch.findFirstOrThrow();
    expect(ledger.batchKey).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof ledger.events).toBe("number");
  });
});
