import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { TENANT_MODELS } from "@/lib/db/tenantModels";
import { createTestAdmin } from "@/test/fixtures";

/**
 * M12 A6 — tenant enumeration (Rule 2, Q-50, M12 acceptance #4). DISCOVERED, not listed: every
 * exported function of every `"use server"` file under src/, every HTTP method of every
 * `route.ts` under src/app, and every Ask AI tool. Each is called with a REAL workspace-A session
 * (a Session row; only the cookie read is stubbed) and workspace B's ids in every common input
 * shape (FormData; (prevState, FormData); an object; a bare id). The invariant, for every entry:
 *   1. workspace B's data is byte-identical afterwards (one hash over every [W] table), and
 *   2. nothing B-specific (any B id or B's marker text) appears in what the call returned.
 * Throwing, refusing or redirecting is a pass. A new action or route is covered automatically;
 * an exemption must name a discovered entry and a reason, or the test fails.
 */
const SESSION_TOKEN = `enum-${randomBytes(16).toString("hex")}`;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "authjs.session-token" ? { value: SESSION_TOKEN } : undefined),
    getAll: () => [{ name: "authjs.session-token", value: SESSION_TOKEN }],
    set: () => undefined,
    delete: () => undefined,
    has: (name: string) => name === "authjs.session-token",
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7", host: "localhost" }),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
  unstable_cache: <T>(fn: T) => fn,
}));

const ROOT = path.resolve(__dirname, "../../../..");
const SRC = path.join(ROOT, "src");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === "node_modules" || name === "__tests__") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);
const actionFiles = files.filter((f) =>
  /^\s*["']use server["'];?/m.test(readFileSync(f, "utf8").slice(0, 400)),
);
const routeFiles = files.filter(
  (f) => f.startsWith(path.join(SRC, "app")) && path.basename(f) === "route.ts",
);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Entries deliberately not exercised here, each with its reason (must exist when discovered). */
const EXEMPT: Record<string, string> = {
  "src/app/api/auth/[...nextauth]/route.ts#GET": "Auth.js protocol endpoint; holds no tenant data",
  "src/app/api/auth/[...nextauth]/route.ts#POST": "Auth.js protocol endpoint; holds no tenant data",
};

const MARK = `ZZB${randomUUID().slice(0, 8)}`;
let A: Awaited<ReturnType<typeof createTestAdmin>>["actor"];
let B: Awaited<ReturnType<typeof createTestAdmin>>["actor"];
const bIds: Record<string, string> = {};

async function seedB() {
  const db = scopedDb(B);
  const ws = B.workspaceId;
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: `${MARK} Account`,
      tier: "MID_TOUCH",
      ownerMembershipId: B.membershipId,
    },
  });
  const contact = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      name: `${MARK} Contact`,
      email: `${MARK.toLowerCase()}@b.example`,
    },
  });
  const signal = await db.signal.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      ruleKey: "usage_drop_vs_normal",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: "RISK",
      title: `${MARK} Signal`,
      explanation: "e",
      evidence: [{ sourceType: "Account", sourceId: account.id }],
      values: {},
      params: {},
      dedupeKey: `enum:${account.id}`,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    },
  });
  const task = await db.task.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      title: `${MARK} Task`,
      ownerMembershipId: B.membershipId,
    },
  });
  const approval = await db.approval.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      kind: "CREATE_TASK",
      payload: {},
      reason: `${MARK} Approval`,
      proof: [{ sourceType: "Account", sourceId: account.id }],
      requiredLevel: "DRAFT_FOR_APPROVAL",
      sourceKey: `enum:${randomUUID()}`,
    },
  });
  const note = await db.note.create({
    data: { workspaceId: ws, accountId: account.id, body: `${MARK} Note` },
  });
  const promise = await db.promise.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      party: "US",
      what: `${MARK} Promise`,
      statusReason: "r",
      dedupeKey: `enum:${randomUUID()}`,
    },
  });
  const segment = await db.segment.create({
    data: { workspaceId: ws, name: `${MARK} Segment`, filter: {} },
  });
  const play = await db.play.create({
    data: { workspaceId: ws, key: `enum-${randomUUID().slice(0, 6)}`, name: `${MARK} Play` },
  });
  const file = await db.fileObject.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      purpose: "CONTRACT_DOCUMENT",
      storageKey: `ws/${ws}/enum/${randomUUID()}`,
      filename: `${MARK}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 10,
      sha256: "0".repeat(64),
      scanStatus: "CLEAN",
      uploadedByMembershipId: B.membershipId,
    },
  });
  const integration = await db.integration.create({
    data: { workspaceId: ws, provider: "HUBSPOT" },
  });
  const thread = await db.askThread.create({
    data: {
      workspaceId: ws,
      userId: B.userId,
      membershipId: B.membershipId,
      title: `${MARK} Thread`,
    },
  });
  Object.assign(bIds, {
    accountId: account.id,
    contactId: contact.id,
    signalId: signal.id,
    taskId: task.id,
    approvalId: approval.id,
    noteId: note.id,
    promiseId: promise.id,
    segmentId: segment.id,
    playId: play.id,
    fileId: file.id,
    integrationId: integration.id,
    threadId: thread.id,
    membershipId: B.membershipId,
    memberId: B.membershipId,
    ownerMembershipId: B.membershipId,
    userId: B.userId,
    workspaceId: B.workspaceId,
  });
}

/** One hash over every [W] table's rows for workspace B (B's data, byte for byte). */
async function hashB(): Promise<string> {
  const parts = TENANT_MODELS.map(
    (m) =>
      `SELECT '${m}' AS t, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${m}" x WHERE x."workspaceId" = $1`,
  ).join(" UNION ALL ");
  // UNION ALL has no guaranteed row order (Parallel Append under load), so sort by table; and
  // ~80 aggregates can exceed the 5s interactive-transaction default on a busy database.
  const rows = await rawDb.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${B.workspaceId}, true)`;
      return tx.$queryRawUnsafe<Array<{ t: string; h: string }>>(parts, B.workspaceId);
    },
    { timeout: 30_000 },
  );
  return rows
    .map((r) => `${r.t}:${r.h}`)
    .sort()
    .join(",");
}

const leaks = (value: unknown): string[] => {
  let text: string;
  try {
    text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "";
  } catch {
    text = String(value);
  }
  return [MARK, ...Object.values(bIds).filter((id) => id !== A.workspaceId)].filter((s) =>
    text.includes(s),
  );
};

function formWithBIds(): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(bIds)) fd.set(k, v);
  fd.set("id", bIds.accountId!);
  fd.set("confirm", "yes");
  fd.set("note", "enumeration");
  fd.set("reason", "enumeration");
  return fd;
}
const objectWithBIds = () => ({ ...bIds, id: bIds.accountId, confirm: "yes", note: "enumeration" });

const covered: string[] = [];
let before: string;

beforeAll(async () => {
  ({ actor: A } = await createTestAdmin("EnumA"));
  ({ actor: B } = await createTestAdmin("EnumB"));
  await seedB();
  await rawDb.session.create({
    data: {
      sessionToken: SESSION_TOKEN,
      userId: A.userId,
      expires: new Date(Date.now() + 3_600_000),
      activeWorkspaceId: A.workspaceId,
    },
  });
  before = await hashB();
}, 60_000);

afterAll(async () => {
  await rawDb.session.deleteMany({ where: { sessionToken: SESSION_TOKEN } });
});

async function check(entry: string, call: () => Promise<unknown>) {
  let out: unknown;
  try {
    out = await call();
  } catch (e) {
    out = e instanceof Error ? { error: e.message } : e;
  }
  expect(leaks(out), `${entry} returned workspace B data`).toEqual([]);
  expect(await hashB(), `${entry} changed workspace B`).toBe(before);
}

describe("tenant enumeration — every Server Action, Route Handler and Ask AI tool", () => {
  it("discovers the surface", () => {
    expect(actionFiles.length).toBeGreaterThan(20);
    expect(routeFiles.length).toBeGreaterThan(10);
    const rel = new Set(
      routeFiles.flatMap((f) => METHODS.map((m) => `${path.relative(ROOT, f)}#${m}`)),
    );
    for (const key of Object.keys(EXEMPT))
      expect(rel.has(key), `stale exemption ${key}`).toBe(true);
  });

  it("Server Actions: workspace B ids never read or change B", async () => {
    for (const file of actionFiles) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== "function") continue;
        const entry = `${path.relative(ROOT, file)}#${name}`;
        if (EXEMPT[entry]) continue;
        const f = fn as (...a: unknown[]) => Promise<unknown>;
        await check(`${entry}(FormData)`, () => f(formWithBIds()));
        await check(`${entry}(state, FormData)`, () => f({}, formWithBIds()));
        await check(`${entry}(object)`, () => f(objectWithBIds()));
        await check(`${entry}(id)`, () => f(bIds.accountId));
        covered.push(entry);
      }
    }
  }, 600_000);

  it("Route Handlers: workspace B ids never read or change B", async () => {
    for (const file of routeFiles) {
      const mod = (await import(file)) as Record<string, unknown>;
      const rel = path.relative(ROOT, file);
      for (const method of METHODS) {
        const fn = mod[method];
        if (typeof fn !== "function") continue;
        const entry = `${rel}#${method}`;
        if (EXEMPT[entry]) continue;
        const params = {
          id: bIds.fileId,
          integrationId: bIds.integrationId,
          provider: "hubspot",
          slug: "accounts",
          token: "x",
          nextauth: ["session"],
        };
        const qs = new URLSearchParams(bIds).toString();
        const init: RequestInit =
          method === "GET" || method === "DELETE"
            ? { method }
            : {
                method,
                body: JSON.stringify(objectWithBIds()),
                headers: { "content-type": "application/json" },
              };
        await check(entry, async () => {
          const res = (await (fn as (r: Request, c: unknown) => Promise<Response>)(
            new Request(`http://localhost/x?${qs}`, init),
            { params: Promise.resolve(params) },
          )) as Response;
          return { status: res.status, body: await res.text() };
        });
        covered.push(entry);
      }
    }
  }, 300_000);

  it("Ask AI tools: workspace B ids never read B", async () => {
    const { ASK_TOOLS, runAskTool } = await import("@/modules/ask-ai/service");
    for (const tool of ASK_TOOLS) {
      await check(`ask-ai#${tool.name}`, () =>
        runAskTool(A, tool.name, {
          accountId: bIds.accountId,
          documentId: bIds.accountId,
          fileId: bIds.fileId,
          query: MARK,
        }),
      );
      covered.push(`ask-ai#${tool.name}`);
    }
  });

  it("reports what it covered", () => {
    const counts = {
      actions: covered.filter(
        (c) =>
          c.includes("/actions") ||
          c.includes("actions.ts") ||
          (!c.includes("route.ts") && !c.startsWith("ask-ai")),
      ).length,
      routes: covered.filter((c) => c.includes("route.ts")).length,
      tools: covered.filter((c) => c.startsWith("ask-ai")).length,
      exempt: Object.keys(EXEMPT).length,
    };
    console.log(`tenant-enumeration coverage: ${JSON.stringify(counts)}`);
    expect(counts.routes).toBeGreaterThan(10);
    expect(counts.tools).toBeGreaterThan(10);
  });
});
