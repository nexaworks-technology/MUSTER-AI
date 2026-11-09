import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { listActiveWorkspaces } from "@/lib/db/workspace";
import { createTestAdmin } from "@/test/fixtures";
import { activateModel, runBacktestProposal } from "@/modules/health/service";
import {
  applyProposedPlays,
  createDefaultSegments,
  getSetupState,
  goLive,
  keepDefaultModel,
  saveTierRule,
  SetupError,
} from "../service";

/**
 * The setup wizard (M5 §2, acceptance #12/#13): CSV-only path on a fresh workspace still in setup;
 * tier bands saved and accounts re-tiered by the rule; default segments created once; the health
 * model's back-test sentence comes from the M3 engine; Go live needs an account and an approved,
 * back-tested model, and only then does the workspace get a nightly run.
 */
const NOW = new Date("2026-11-02T17:00:00Z");

async function fresh(label: string) {
  const { actor, workspace } = await createTestAdmin(label);
  await rawDb.workspace.update({ where: { id: workspace.id }, data: { setupPending: true } });
  return { actor, db: scopedDb(actor) };
}

describe("setup wizard", () => {
  it("a workspace in setup gets no nightly run until it goes live", async () => {
    const S = await fresh("SetupLive");
    expect((await listActiveWorkspaces()).some((w) => w.id === S.actor.workspaceId)).toBe(false);
    await expect(goLive(S.actor)).rejects.toThrow(
      new SetupError("Import or sync at least one account before going live."),
    );
    await S.db.account.create({
      data: { workspaceId: S.actor.workspaceId, name: "First Co", tier: "LONG_TAIL" },
    });
    await expect(goLive(S.actor)).rejects.toThrow(/Review and approve the proposed health model/);

    // Step 4: the M3 engine back-tests and proposes. With one account there is no history, so the
    // engine refuses to activate its proposal and the Admin keeps the default instead (D-96).
    const draft = await runBacktestProposal(S.actor, () => NOW);
    const state = await getSetupState(S.actor);
    expect(state.health.proposal?.id).toBe(draft.id);
    expect(state.health.proposal?.sentence).toMatch(
      /^With this model, we would have flagged \d+ of your last \d+ churns/,
    );
    expect(state.health.proposal?.caveat).toMatch(/could not be back-tested|needed|enough/);
    await expect(activateModel(S.actor, draft.id)).rejects.toThrow(/5 of each are needed/);
    await expect(goLive(S.actor)).rejects.toThrow(/Review and approve/);
    await keepDefaultModel(S.actor);
    expect((await getSetupState(S.actor)).health.keptDefault).toBe(true);

    // Two clicks at once: exactly one goes live, one audit row.
    const both = await Promise.all([goLive(S.actor), goLive(S.actor)]);
    expect(both.filter((r) => !r.alreadyLive)).toHaveLength(1);
    expect((await getSetupState(S.actor)).setupPending).toBe(false);
    expect((await listActiveWorkspaces()).some((w) => w.id === S.actor.workspaceId)).toBe(true);
    expect(await S.db.auditLog.count({ where: { action: "workspace.went_live" } })).toBe(1);
    expect(await goLive(S.actor)).toEqual({ alreadyLive: true });
  });

  it("tier bands: refuses a high band at or below the mid band; re-tiers rule accounts; audited", async () => {
    const S = await fresh("SetupTiers");
    const ws = S.actor.workspaceId;
    const acct = await S.db.account.create({
      data: { workspaceId: ws, name: "Ten K", tier: "LONG_TAIL", tierSource: "RULE" },
    });
    await S.db.contract.create({
      data: {
        workspaceId: ws,
        accountId: acct.id,
        startDate: new Date("2026-01-01"),
        valueMinor: 3_000_000n,
        currency: "USD",
      },
    });
    const manual = await S.db.account.create({
      data: { workspaceId: ws, name: "Manual", tier: "HIGH_TOUCH", tierSource: "MANUAL" },
    });
    await expect(
      saveTierRule(S.actor, { highTouchMinArr: 5000, midTouchMinArr: 5000 }),
    ).rejects.toThrow(/high-touch amount must be above/);
    // ARR is derived when contracts change; set it directly for this unit.
    await S.db.account.update({
      where: { id: acct.id },
      data: { arrMinor: 3_000_000n, arrCurrency: "USD" },
    });
    await saveTierRule(S.actor, { highTouchMinArr: "25000", midTouchMinArr: "5000" });
    expect((await S.db.account.findUniqueOrThrow({ where: { id: acct.id } })).tier).toBe(
      "HIGH_TOUCH",
    );
    expect((await S.db.account.findUniqueOrThrow({ where: { id: manual.id } })).tier).toBe(
      "HIGH_TOUCH",
    );
    expect((await getSetupState(S.actor)).tierRule).toEqual({
      highTouchMinArr: 25000,
      midTouchMinArr: 5000,
    });
    const log = await S.db.auditLog.findFirstOrThrow({
      where: { action: "settings.tier_rule_changed" },
    });
    expect(log.before).toEqual({ highTouchMinArr: 50000, midTouchMinArr: 10000 });
  });

  it("creates the default segments once", async () => {
    const S = await fresh("SetupSegments");
    expect(await createDefaultSegments(S.actor)).toBe(3);
    expect(await createDefaultSegments(S.actor)).toBe(0);
    expect((await getSetupState(S.actor)).segments.sort()).toEqual(
      ["High-touch accounts", "Onboarding", "Renewing in the next 90 days"].sort(),
    );
  });

  it("creates proposed plays as drafts during setup and audits it", async () => {
    const S = await fresh("SetupPlays");
    await S.db.account.create({
      data: { workspaceId: S.actor.workspaceId, name: "Acme", tier: "HIGH_TOUCH" },
    });

    const state = await getSetupState(S.actor);
    expect(state.plays.proposed.length).toBeGreaterThan(0);
    const healthRisk = state.plays.proposed.find((p) => p.playKey === "health-risk");
    expect(healthRisk).toBeDefined();

    const created = await applyProposedPlays(S.actor, ["health-risk", "champion-loss"]);
    expect(created).toBe(2);

    const playsInDb = await S.db.play.findMany({
      where: { workspaceId: S.actor.workspaceId },
    });
    expect(playsInDb).toHaveLength(2);
    expect(playsInDb.every((p) => p.status === "DRAFT")).toBe(true);

    const audit = await S.db.auditLog.findFirst({
      where: { action: "setup.play_proposed", workspaceId: S.actor.workspaceId },
    });
    expect(audit).toBeDefined();
  });

  it("counts unowned accounts so the wizard can warn during import", async () => {
    const S = await fresh("SetupUnowned");
    await S.db.account.create({
      data: { workspaceId: S.actor.workspaceId, name: "Unowned Co", tier: "HIGH_TOUCH" },
    });
    const state = await getSetupState(S.actor);
    expect(state.counts.accounts).toBe(1);
    expect(state.counts.unownedAccounts).toBe(1);
  });

  it("is Admin only", async () => {
    const S = await fresh("SetupRole");
    await expect(getSetupState({ ...S.actor, role: "CS_LEADER" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(goLive({ ...S.actor, role: "CSM" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
