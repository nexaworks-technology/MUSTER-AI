import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { getBilling, saveContract } from "../service";

/**
 * Field-level protection (spec §6N3, INTERP-4): without revenue access, no money value and no
 * decrypted term ever leaves the billing service.
 */
const MONEY_KEYS = [
  "valueMinor",
  "amountMinor",
  "deltaArrMinor",
  "arrMinor",
  "terms",
  "pricingNotes",
  "termsEnc",
  "pricingNotesEnc",
];

function moneyKeysIn(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => moneyKeysIn(v, `${path}[${i}]`));
  if (value === null || typeof value !== "object" || value instanceof Date) return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(MONEY_KEYS.includes(k) ? [`${path}.${k}`] : []),
    ...moneyKeysIn(v, `${path}.${k}`),
  ]);
}

let finance: Actor;
let csm: Actor;
let accountId: string;

beforeAll(async () => {
  const a = await createTestAdmin("Redact");
  finance = a.actor;
  csm = { ...finance, role: "CSM", canViewRevenue: false, bookScope: "ALL" };
  const db = scopedDb(finance);
  accountId = (
    await db.account.create({
      data: { workspaceId: finance.workspaceId, name: "Money Co", tier: "MID_TOUCH" },
    })
  ).id;
  const contract = await saveContract(finance, {
    accountId,
    startDate: new Date("2026-01-01"),
    renewalDate: new Date("2027-01-01"),
    endDate: new Date("2027-01-01"),
    valueMinor: 3_600_000n,
    currency: "USD",
    seatsPurchased: 40,
    noticePeriodDays: 30,
    terms: "Net 30. Auto-renews unless notice is given.",
    pricingNotes: "10% multi-year discount",
  });
  const sub = await db.subscription.create({
    data: {
      workspaceId: finance.workspaceId,
      accountId,
      contractId: contract.id,
      plan: "Growth",
      interval: "YEAR",
      amountMinor: 3_600_000n,
    },
  });
  await db.invoice.create({
    data: {
      workspaceId: finance.workspaceId,
      accountId,
      subscriptionId: sub.id,
      number: "INV-1",
      amountMinor: 3_600_000n,
      issuedAt: new Date("2026-01-01"),
      dueAt: new Date("2026-01-31"),
      status: "FAILED",
      failureCount: 1,
    },
  });
});

describe("redactFinancials", () => {
  it("returns every money field and decrypted terms to members with revenue access", async () => {
    const billing = await getBilling(finance, accountId);
    expect(billing.moneyVisible).toBe(true);
    expect(billing.contracts[0]).toMatchObject({
      valueMinor: 3_600_000n,
      terms: "Net 30. Auto-renews unless notice is given.",
    });
    expect("arrMinor" in billing.account ? billing.account.arrMinor : undefined).toBe(3_600_000n);
    expect(billing.invoices[0]!.amountMinor).toBe(3_600_000n);
    expect(billing.revenueEvents.map((e) => e.type)).toEqual(["NEW"]);
  });

  it("returns no money field and no terms to members without revenue access", async () => {
    const billing = await getBilling(csm, accountId);
    expect(billing.moneyVisible).toBe(false);
    expect(moneyKeysIn(billing)).toEqual([]);
    // Operational facts stay visible: seats, dates, invoice status.
    expect(billing.contracts[0]).toMatchObject({ seatsPurchased: 40, noticePeriodDays: 30 });
    expect(billing.invoices[0]).toMatchObject({ number: "INV-1", status: "FAILED" });
  });

  it("stores terms and pricing notes as ciphertext", async () => {
    const [row] = await scopedDb(finance).contract.findMany({ where: { accountId } });
    expect(row!.termsEnc).not.toContain("Net 30");
    expect(row!.termsEnc!.startsWith("k1.") || /^[A-Za-z0-9_-]+\./.test(row!.termsEnc!)).toBe(true);
    expect(row!.pricingNotesEnc).not.toContain("discount");
  });

  it("derives the account's ARR and renewal date from the current contract", async () => {
    const account = await scopedDb(finance).account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.arrMinor).toBe(3_600_000n);
    expect(account.renewalDate?.toISOString().slice(0, 10)).toBe("2027-01-01");
  });

  it("only revenue members may record contract values", async () => {
    await expect(
      saveContract(csm, {
        accountId,
        startDate: new Date("2026-01-01"),
        valueMinor: 1n,
        currency: "USD",
      }),
    ).rejects.toThrow(/revenue:view/);
  });
});
