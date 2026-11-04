import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AiProvider } from "@/lib/ai";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { defineAgent } from "../define";
import { runAgent } from "../executor";
import { baseAgentOutput } from "../schemas";
import { AgentRunNotFoundError, getRunDetail, listAgentTeam, setAgentEnabled } from "../team";

/**
 * Settings › AI team and run detail (M4 acceptance #12): what each agent read, decided and did; a
 * CSM sees runs on their own accounts only; an Admin can switch an agent off (audited), after which
 * its runs are SKIPPED and no model is called.
 */
let admin: Actor;
let leo: Actor;
let db: ScopedDb;
let mine: string;
let notMine: string;

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("Team"));
  db = scopedDb(admin);
  const user = await rawDb.user.create({
    data: { email: `leo-${randomUUID()}@t.test`, name: "Leo" },
  });
  const m = await db.membership.create({
    data: { workspaceId: admin.workspaceId, userId: user.id, role: "CSM" },
  });
  leo = {
    workspaceId: admin.workspaceId,
    userId: user.id,
    membershipId: m.id,
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  };
  mine = (
    await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Leo's",
        tier: "HIGH_TOUCH",
        ownerMembershipId: m.id,
      },
    })
  ).id;
  notMine = (
    await db.account.create({
      data: { workspaceId: admin.workspaceId, name: "Not Leo's", tier: "HIGH_TOUCH" },
    })
  ).id;
});

const run = (accountId: string) =>
  db.agentRun.create({
    data: {
      workspaceId: admin.workspaceId,
      agentKey: "health-analyst",
      agentVersion: "1.0.0",
      promptName: "health-analyst",
      promptVersion: "1.0.0",
      model: "m",
      modelTier: "standard",
      triggerType: "t",
      triggerId: randomUUID(),
      idempotencyKey: randomUUID(),
      accountId,
      inputRefs: [{ sourceType: "Account", sourceId: accountId }],
      status: "SUCCEEDED",
      output: { items: [] },
      reasoningSummary: "Nothing to act on.",
      confidence: 0.6,
      effects: [],
    },
  });

describe("AI team", () => {
  it("lists every registered agent with its tier, switch and run counts", async () => {
    await run(mine);
    const team = await listAgentTeam(admin);
    expect(team.map((a) => a.key).sort()).toEqual([
      "adoption-coach",
      "expansion-finder",
      "health-analyst",
      "onboarding-manager",
      "outreach",
      "renewal-manager",
      "watcher",
    ]);
    const ha = team.find((a) => a.key === "health-analyst")!;
    expect(ha).toMatchObject({
      tier: "standard",
      enabled: true,
      internalOnly: true,
      counts: { SUCCEEDED: 1 },
    });
    expect(team.find((a) => a.key === "outreach")!.internalOnly).toBe(false);
  });

  it("run detail shows what it read as links; a CSM sees only runs on their own accounts", async () => {
    const r = await run(mine);
    const d = await getRunDetail(leo, r.id);
    expect(d.read).toEqual([
      expect.objectContaining({ label: "Account: Leo's", href: `/accounts/${mine}` }),
    ]);
    const other = await run(notMine);
    await expect(getRunDetail(leo, other.id)).rejects.toBeInstanceOf(AgentRunNotFoundError);
    expect((await getRunDetail(admin, other.id)).run.id).toBe(other.id);
  });

  it("an Admin switches an agent off (audited); its next run is SKIPPED and calls no model", async () => {
    await setAgentEnabled(admin, { agentKey: "health-analyst", enabled: "false" });
    expect(
      await db.auditLog.findFirst({
        where: { action: "agent.disabled", targetId: "health-analyst" },
      }),
    ).not.toBeNull();
    const calls: number[] = [];
    const provider: AiProvider = {
      name: "recorded",
      async generateStructured() {
        calls.push(1);
        throw new Error("must not be called");
      },
    };
    const agent = defineAgent({
      key: "health-analyst",
      version: "1.0.0",
      description: "d",
      modelTier: "standard",
      tierReason: "t",
      prompt: { name: "test-agent", version: "1.0.0" },
      inputSchema: z.object({}),
      outputSchema: baseAgentOutput,
      buildContext: async () => ({ bundle: [], vars: { accountName: "x" } }),
      forbiddenNumericFields: [],
      approvalPolicy: "INTERNAL",
    });
    const out = await runAgent(
      admin,
      agent,
      {},
      { type: "t", id: "off" },
      { provider, promptsDir: path.join(import.meta.dirname, "fixtures/prompts") },
    );
    expect(out).toMatchObject({ status: "SKIPPED" });
    expect(calls).toHaveLength(0);
    expect(await db.agentRun.findFirstOrThrow({ where: { triggerId: "off" } })).toMatchObject({
      errorCode: "DISABLED",
    });
    await setAgentEnabled(admin, { agentKey: "health-analyst", enabled: "true" });
  });
});
