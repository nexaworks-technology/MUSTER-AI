import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import {
  confirmImport,
  getImport,
  previewImport,
  runImportJob,
  startImport,
} from "@/modules/imports/service";
import { createTestAdmin } from "@/test/fixtures";
import { outsideLabel } from "../schemas";
import { createOutsideSignal, evaluateAndStore } from "../service";

/**
 * Outside signals (spec §6D, INTERP-6, M3.md): only from a dated public source, never framed as
 * fresh when old, entered by hand or by CSV (the template deferred from M2).
 */
const TODAY = "2026-11-02";
const clock = () => new Date(`${TODAY}T12:00:00Z`);
let admin: Actor;
let viewer: Actor;
let accountId: string;

beforeAll(async () => {
  admin = (await createTestAdmin("Outside")).actor;
  const db = scopedDb(admin);
  const ws = admin.workspaceId;
  const u = await db.user.create({ data: { email: `v-${ws}@example.test`, name: "V" } });
  const m = await db.membership.create({ data: { workspaceId: ws, userId: u.id, role: "VIEWER" } });
  viewer = {
    ...admin,
    userId: u.id,
    membershipId: m.id,
    role: "VIEWER",
    canViewRevenue: false,
    bookScope: "ALL",
  };
  accountId = (
    await db.account.create({
      data: {
        workspaceId: ws,
        name: "Brightwell",
        domain: "brightwell.test",
        tier: "HIGH_TOUCH",
        arrMinor: 18_600_000n,
        arrCurrency: "USD",
      },
    })
  ).id;
});

const input = (o: Record<string, unknown> = {}) => ({
  accountId,
  kind: "ACQUISITION",
  headline: "Acquired by Haverford Group",
  sourceUrl: "https://news.example.test/haverford-brightwell",
  eventDate: "2026-10-20",
  ...o,
});

describe("outside signals", () => {
  it("refuse a missing or non-web source, a missing date, or a date in the future", async () => {
    for (const bad of [
      input({ sourceUrl: "" }),
      input({ sourceUrl: "ftp://news.example.test/x" }),
      input({ sourceUrl: "not a url" }),
      input({ eventDate: "" }),
      input({ eventDate: "2026-11-05" }),
    ])
      await expect(createOutsideSignal(admin, bad, clock)).rejects.toThrow();
    expect(await scopedDb(admin).signal.count({ where: { category: "OUTSIDE" } })).toBe(0);
  });

  it("the database refuses an outside signal without its public source too", async () => {
    await expect(
      scopedDb(admin).signal.create({
        data: {
          workspaceId: admin.workspaceId,
          accountId,
          ruleKey: "outside_event",
          ruleVersion: 1,
          category: "OUTSIDE",
          severity: "WARN",
          polarity: "RISK",
          title: "x",
          explanation: "x",
          evidence: [{ sourceType: "PublicSource" }],
          values: {},
          params: {},
          dedupeKey: "raw",
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      }),
    ).rejects.toThrow(/outside_has_public_source/);
  });

  it("records a dated public event once, by a person, with its outcome record", async () => {
    const s = await createOutsideSignal(admin, input(), clock);
    expect(s).toMatchObject({
      category: "OUTSIDE",
      polarity: "RISK",
      origin: "HUMAN",
      publicSourceUrl: "https://news.example.test/haverford-brightwell",
      createdByMembershipId: admin.membershipId,
      title: "Acquisition: Acquired by Haverford Group",
    });
    expect(s.publicSourceDate?.toISOString().slice(0, 10)).toBe("2026-10-20");
    const again = await createOutsideSignal(admin, input(), clock);
    expect(again.id).toBe(s.id);
    const db = scopedDb(admin);
    expect(await db.signal.count({ where: { category: "OUTSIDE" } })).toBe(1);
    expect(await db.outcomeRecord.count({ where: { signalId: s.id } })).toBe(1);
    expect(
      await db.auditLog.count({ where: { action: "signal.outside_added", targetId: s.id } }),
    ).toBe(1);
  });

  it("is never framed as fresh when old: 'Reported <date>' after 30 days", () => {
    expect(outsideLabel("2026-10-20", TODAY, 30)).toBe("New · Oct 20, 2026");
    expect(outsideLabel("2026-10-03", TODAY, 30)).toBe("New · Oct 3, 2026");
    expect(outsideLabel("2026-10-02", TODAY, 30)).toBe("Reported Oct 2, 2026");
    expect(outsideLabel("2026-08-14", TODAY, 30)).toBe("Reported Aug 14, 2026");
  });

  it("viewers cannot add outside signals", async () => {
    await expect(
      createOutsideSignal(viewer, input({ eventDate: "2026-10-01" }), clock),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the nightly evaluation never resolves or invents outside signals", async () => {
    await evaluateAndStore(admin, [accountId], TODAY, clock);
    const rows = await scopedDb(admin).signal.findMany({ where: { category: "OUTSIDE" } });
    expect(rows.map((r) => r.status)).toEqual(["OPEN"]);
  });

  it("imports from the outside-signal CSV template; re-import creates nothing; bad rows say why", async () => {
    const csv = [
      "account_domain,kind,headline,source_url,event_date",
      "brightwell.test,Leadership change,New COO appointed,https://news.example.test/coo,2026-10-25",
      "brightwell.test,Funding,Series C,,2026-10-01",
    ].join("\n");
    const run = async () => {
      const job = await startImport(admin, "OUTSIDE_SIGNALS", {
        filename: "outside.csv",
        bytes: new TextEncoder().encode(csv),
      });
      const report = await previewImport(admin, job.id);
      await confirmImport(admin, job.id);
      await runImportJob(admin.workspaceId, job.id);
      return { report, result: await getImport(admin, job.id) };
    };
    const first = await run();
    expect(first.report.preview).toMatchObject({ create: 1, fail: 1 });
    expect(first.report.errors.map((e) => e.message).join()).toMatch(
      /public source link is required/i,
    );
    expect(first.result).toMatchObject({ created: 1 });
    const again = await run();
    expect(again.result).toMatchObject({ created: 0, unchanged: 1 });
    const coo = await scopedDb(admin).signal.findFirstOrThrow({
      where: { title: { contains: "New COO" } },
    });
    expect(coo).toMatchObject({
      category: "OUTSIDE",
      origin: "IMPORT",
      publicSourceUrl: "https://news.example.test/coo",
    });
  });
});
