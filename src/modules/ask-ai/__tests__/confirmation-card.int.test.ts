import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { decideFromAsk, loadApprovalCard, proposeChanges, type AskActor } from "../service";

/**
 * M11 S11 (D-160 founder condition): the Ask confirmation card is a view onto the Approval. A
 * viewer who could not decide it in /approvals gets no controls and the action refuses them; Yes
 * executes through approvals.approve() and changes nothing before it.
 */
let admin: AskActor;
let leo: AskActor;
let viewer: AskActor;
let aisha: AskActor;
let db: ScopedDb;
let ws: string;

async function member(role: "CSM" | "VIEWER", name: string): Promise<AskActor> {
  const user = await rawDb.user.create({
    data: { email: `${name}-${randomUUID().slice(0, 8)}@example.test`, name },
  });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return tx.membership.create({
      data: {
        workspaceId: ws,
        userId: user.id,
        role,
        bookScope: role === "CSM" ? "OWN" : "ALL",
        canViewRevenue: false,
      },
    });
  });
  return {
    workspaceId: ws,
    userId: user.id,
    membershipId: m.id,
    role: m.role,
    canViewRevenue: false,
    bookScope: m.bookScope,
  };
}

async function proposal(title: string) {
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: `Card ${title}`,
      tier: "MID_TOUCH",
      ownerMembershipId: leo.membershipId,
    },
  });
  const p = await proposeChanges(leo, {
    reason: `Follow up on ${title}`,
    items: [{ kind: "CREATE_TASK", accountId: account.id, title }],
    proof: [{ sourceType: "Account", sourceId: account.id }],
    sourceKey: `t:${randomUUID()}`,
  });
  return { account, approvalId: p.approvalId! };
}

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("AskCard"));
  ws = admin.workspaceId;
  db = scopedDb(admin);
  leo = await member("CSM", "leo");
  aisha = await member("CSM", "aisha");
  viewer = await member("VIEWER", "vee");
});

describe("Ask confirmation card", () => {
  it("shows the exact change list to the account owner, with decide controls", async () => {
    const { approvalId } = await proposal("Call the champion");
    const card = await loadApprovalCard(leo, approvalId);
    expect(card).toMatchObject({ visible: true, status: "PENDING", canDecide: true });
    expect(card.changes).toHaveLength(1);
    expect(card.changes![0]).toMatch(/Call the champion/);
  });

  it("a viewer who cannot decide sees the card but gets no controls, and the action refuses them", async () => {
    const { approvalId, account } = await proposal("Viewer cannot decide");
    const card = await loadApprovalCard(viewer, approvalId);
    expect(card.visible).toBe(true);
    expect(card.canDecide).toBe(false);
    await expect(decideFromAsk(viewer, { approvalId, decision: "yes" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(decideFromAsk(viewer, { approvalId, decision: "no" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await db.task.count({ where: { accountId: account.id } })).toBe(0);
    expect((await db.approval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe(
      "PENDING",
    );
  });

  it("another CSM whose book excludes the account cannot see it or decide it", async () => {
    const { approvalId } = await proposal("Not aisha's");
    expect(await loadApprovalCard(aisha, approvalId)).toEqual({ id: approvalId, visible: false });
    await expect(decideFromAsk(aisha, { approvalId, decision: "yes" })).rejects.toThrow();
  });

  it("Yes executes through approve(); nothing changed before it; the card then shows the results", async () => {
    const { approvalId, account } = await proposal("Book the QBR");
    expect(await db.task.count({ where: { accountId: account.id } })).toBe(0);
    await decideFromAsk(leo, { approvalId, decision: "yes" });
    expect(await db.task.count({ where: { accountId: account.id, title: "Book the QBR" } })).toBe(
      1,
    );
    const card = await loadApprovalCard(leo, approvalId);
    expect(card).toMatchObject({ status: "APPROVED", canDecide: false });
    expect(card.results).toEqual([expect.objectContaining({ status: "EXECUTED" })]);
    await expect(decideFromAsk(leo, { approvalId, decision: "yes" })).rejects.toThrow(/already/i);
  });

  it("No rejects it and executes nothing", async () => {
    const { approvalId, account } = await proposal("Decline me");
    await decideFromAsk(leo, { approvalId, decision: "no" });
    expect(await db.task.count({ where: { accountId: account.id } })).toBe(0);
    expect((await loadApprovalCard(leo, approvalId)).status).toBe("REJECTED");
  });
});
