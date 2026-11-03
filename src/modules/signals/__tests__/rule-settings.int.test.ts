import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { evaluateAndStore, listRuleSettings, updateRuleSettings } from "../service";

/** Signal thresholds are workspace settings (M3 rule 8): Admin / CS Leader, validated, audited. */
let admin: Actor;
let leader: Actor;
let csm: Actor;

beforeAll(async () => {
  admin = (await createTestAdmin("RuleSettings")).actor;
  const db = scopedDb(admin);
  const ws = admin.workspaceId;
  const mk = async (role: "CS_LEADER" | "CSM") => {
    const u = await db.user.create({ data: { email: `${role}-${ws}@example.test`, name: role } });
    const m = await db.membership.create({ data: { workspaceId: ws, userId: u.id, role } });
    return {
      ...admin,
      userId: u.id,
      membershipId: m.id,
      role,
      canViewRevenue: false,
      bookScope: "OWN" as const,
    };
  };
  leader = await mk("CS_LEADER");
  csm = await mk("CSM");
});

describe("Settings › Signals", () => {
  it("lists every rule with its four spec fields; CSMs cannot open it", async () => {
    const rules = await listRuleSettings(admin);
    expect(rules).toHaveLength(20);
    expect(rules[0]).toMatchObject({
      ruleKey: "usage_drop_vs_normal",
      label: "Usage drop vs normal",
    });
    await expect(listRuleSettings(csm)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a CS Leader changes thresholds: validated, version bumped, audited with before/after", async () => {
    const r = await updateRuleSettings(leader, "invoice_late", {
      params: { graceDays: 14, materialDays: 30 },
    });
    expect(r).toMatchObject({ version: 2, params: { graceDays: 14, materialDays: 30 } });
    const audit = await scopedDb(admin).auditLog.findFirstOrThrow({
      where: { action: "signal_rule.updated", targetId: r.id },
    });
    expect(audit.before).toMatchObject({ version: 1, params: { graceDays: 7 } });
    expect(audit.after).toMatchObject({ version: 2, params: { graceDays: 14 } });
    await expect(
      updateRuleSettings(csm, "invoice_late", { enabled: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses thresholds that contradict each other", async () => {
    await expect(
      updateRuleSettings(admin, "usage_drop_vs_normal", {
        params: {
          warnRatio: 0.4,
          criticalRatio: 0.5,
          clearRatio: 0.8,
          minNormalUsers: 3,
          materialDrop: 0.15,
        },
      }),
    ).rejects.toThrow(/Critical must be below warn/);
  });

  it("refuses to switch on a dormant rule", async () => {
    await expect(
      updateRuleSettings(admin, "no_meeting_in_x_days", { enabled: true }),
    ).rejects.toThrow(/Needs meeting data/);
  });

  it("new signals carry the rule version and thresholds that raised them", async () => {
    const db = scopedDb(admin);
    const acct = await db.account.create({
      data: { workspaceId: admin.workspaceId, name: "Late payer", tier: "LONG_TAIL" },
    });
    await db.invoice.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: acct.id,
        number: "INV-9",
        amountMinor: 100n,
        issuedAt: new Date("2026-09-01"),
        dueAt: new Date("2026-10-01"),
      },
    });
    await evaluateAndStore(admin, [acct.id], "2026-11-02", () => new Date("2026-11-02T03:00:00Z"));
    const s = await db.signal.findFirstOrThrow({
      where: { accountId: acct.id, ruleKey: "invoice_late" },
    });
    expect(s).toMatchObject({
      ruleVersion: 2,
      params: { graceDays: 14 },
      values: { daysLate: 32 },
    });
  });
});
