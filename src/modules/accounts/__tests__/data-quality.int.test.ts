import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  applyDataQualityFixes,
  dismissDataQualityIssue,
  listDataQualityIssues,
  previewDataQualityFixes,
  runDataQualityScan,
} from "../data-quality-service";
import type { Actor } from "../service";

const NOW = new Date("2026-11-02T14:00:00Z");
let admin: Actor;
let csm: Actor;
let other: Actor;
let accountId: string;
let ken: string;
let kenDup: string;
let amy: string;
let amyDup: string;
let pat: string;

beforeAll(async () => {
  admin = (await createTestAdmin("DataQuality")).actor;
  other = (await createTestAdmin("DataQualityOther")).actor;
  const db = scopedDb(admin);
  const ws = admin.workspaceId;
  const user = await db.user.create({ data: { email: `csm-${ws}@example.test`, name: "CSM" } });
  const m = await db.membership.create({ data: { workspaceId: ws, userId: user.id, role: "CSM" } });
  csm = { ...admin, userId: user.id, membershipId: m.id, role: "CSM", bookScope: "OWN" };
  accountId = (
    await db.account.create({
      data: { workspaceId: ws, name: "Silverline", domain: "silverline.test", tier: "MID_TOUCH" },
    })
  ).id;
  const contact = (name: string, email: string, createdAt: string) =>
    db.contact
      .create({
        data: { workspaceId: ws, accountId, name, email, createdAt: new Date(createdAt) },
      })
      .then((c) => c.id);
  ken = await contact("Ken Ward", "ken.ward@silverline.test", "2026-01-01");
  kenDup = await contact("Ken Ward", "KEN.WARD@silverline.test", "2026-07-01");
  amy = await contact("Amy Stone", "amy.stone@silverline.test", "2026-01-01");
  amyDup = await contact("Amy  Stone", "amy.stone@silverline.test ", "2026-08-01");
  pat = await contact("Pat Lee", " Pat@Silverline.TEST", "2026-02-01");
  // History hanging off the duplicate, which a merge must carry over.
  await db.stakeholderRole.create({
    data: { workspaceId: ws, accountId, contactId: kenDup, role: "DAILY_USER", validFrom: NOW },
  });
  await db.ticket.create({
    data: {
      workspaceId: ws,
      accountId,
      contactId: kenDup,
      subject: "Export",
      openedAt: NOW,
    },
  });
  await db.externalRef.create({
    data: {
      workspaceId: ws,
      source: "CSV",
      objectType: "Contact",
      externalId: "K-2",
      internalType: "Contact",
      internalId: kenDup,
    },
  });
});

const issueFor = async (actor: Actor, contactId: string, kind = "DUPLICATE_CONTACT") =>
  (await listDataQualityIssues(actor)).find((i) => i.contactId === contactId && i.kind === kind)!;

describe("data-quality fixes (integration)", () => {
  it("is for Admins and CS Leaders only (data:import)", async () => {
    await expect(runDataQualityScan(csm, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listDataQualityIssues(csm)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("re-scanning does not duplicate issues", async () => {
    await runDataQualityScan(admin, NOW);
    const first = await listDataQualityIssues(admin);
    await runDataQualityScan(admin, NOW);
    expect(await listDataQualityIssues(admin)).toHaveLength(first.length);
    expect(first.map((i) => i.kind)).toEqual(
      expect.arrayContaining(["DUPLICATE_CONTACT", "INVALID_EMAIL"]),
    );
  });

  it("does not apply a fix without confirm: true", async () => {
    const issue = await issueFor(admin, ken);
    const [item] = (await previewDataQualityFixes(admin, [issue.id])).items;
    await expect(
      applyDataQualityFixes(admin, { items: [{ id: item!.id, version: item!.version }] }),
    ).rejects.toThrow();
    await expect(
      applyDataQualityFixes(admin, {
        confirm: false,
        items: [{ id: item!.id, version: item!.version }],
      }),
    ).rejects.toThrow();
    expect(await scopedDb(admin).contact.count({ where: { id: kenDup } })).toBe(1);
  });

  it("previews exactly what a merge will change", async () => {
    const issue = await issueFor(admin, ken);
    const { items } = await previewDataQualityFixes(admin, [issue.id]);
    expect(items).toHaveLength(1);
    expect(items[0]!.changes.join("\n")).toMatch(/Keep Ken Ward/);
    expect(items[0]!.changes.join("\n")).toMatch(/1 role/);
    expect(items[0]!.changes.join("\n")).toMatch(/1 ticket/);
  });

  it("leaves out a fix whose record a merge in the same preview removes", async () => {
    const merge = await issueFor(admin, ken);
    const dupEmail = await issueFor(admin, kenDup, "INVALID_EMAIL");
    const preview = await previewDataQualityFixes(admin, [merge.id, dupEmail.id]);
    expect(preview.items.map((i) => i.id)).toEqual([merge.id]);
    expect(preview.notFixable).toEqual([
      { id: dupEmail.id, reason: expect.stringMatching(/merge/i) },
    ]);
  });

  it("does not let another workspace preview or apply this workspace's fixes", async () => {
    const issue = await issueFor(admin, ken);
    expect((await previewDataQualityFixes(other, [issue.id])).items).toEqual([]);
    const result = await applyDataQualityFixes(other, {
      confirm: true,
      items: [{ id: issue.id, version: issue.updatedAt.toISOString() }],
    });
    expect(result.applied).toEqual([]);
    expect(await scopedDb(admin).contact.count({ where: { id: kenDup } })).toBe(1);
  });

  it("bulk applies exactly the previewed list, skipping anything changed since the preview", async () => {
    const kenIssue = await issueFor(admin, ken);
    const amyIssue = await issueFor(admin, amy);
    const patIssue = await issueFor(admin, pat, "INVALID_EMAIL");
    const preview = await previewDataQualityFixes(admin, [kenIssue.id, amyIssue.id]);
    expect(preview.items.map((i) => i.id).sort()).toEqual([kenIssue.id, amyIssue.id].sort());

    // Amy's issue is dismissed after the preview: it must be skipped, not applied.
    await dismissDataQualityIssue(admin, amyIssue.id);
    const result = await applyDataQualityFixes(admin, {
      confirm: true,
      items: preview.items.map((i) => ({ id: i.id, version: i.version })),
    });
    expect(result.applied).toEqual([kenIssue.id]);
    expect(result.skipped).toEqual([{ id: amyIssue.id, reason: expect.any(String) }]);

    const db = scopedDb(admin);
    expect(await db.contact.count({ where: { id: kenDup } })).toBe(0);
    expect(await db.contact.count({ where: { id: amyDup } })).toBe(1);
    expect(await db.stakeholderRole.count({ where: { contactId: ken } })).toBe(1);
    expect(await db.ticket.count({ where: { contactId: ken } })).toBe(1);
    expect(await db.externalRef.findFirst({ where: { externalId: "K-2" } })).toMatchObject({
      internalId: ken,
    });
    // Pat was not in the preview, so Pat's email is untouched.
    expect((await db.contact.findUniqueOrThrow({ where: { id: pat } })).email).toBe(
      " Pat@Silverline.TEST",
    );
    expect(
      (await db.dataQualityIssue.findUniqueOrThrow({ where: { id: patIssue.id } })).status,
    ).toBe("OPEN");
    expect(
      await db.auditLog.count({
        where: { action: "data_quality.fixed", targetId: kenIssue.id },
      }),
    ).toBe(1);
  });

  it("keeps dismissed issues dismissed and resolves issues that are gone", async () => {
    await runDataQualityScan(admin, NOW);
    const all = await listDataQualityIssues(admin, "ALL");
    expect(all.find((i) => i.contactId === amy)?.status).toBe("DISMISSED");
    expect(all.find((i) => i.contactId === ken && i.kind === "DUPLICATE_CONTACT")?.status).toBe(
      "FIXED",
    );
  });

  it("normalises an email only on confirm", async () => {
    const issue = await issueFor(admin, pat, "INVALID_EMAIL");
    const { items } = await previewDataQualityFixes(admin, [issue.id]);
    expect(items[0]!.changes).toEqual([
      'Change Pat Lee\'s email from " Pat@Silverline.TEST" to "pat@silverline.test".',
    ]);
    await applyDataQualityFixes(admin, {
      confirm: true,
      items: [{ id: items[0]!.id, version: items[0]!.version }],
    });
    expect((await scopedDb(admin).contact.findUniqueOrThrow({ where: { id: pat } })).email).toBe(
      "pat@silverline.test",
    );
  });
});
