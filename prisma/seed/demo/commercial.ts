import type { Prisma } from "@prisma/client";
import { fieldCipher } from "@/lib/crypto";
import type { ScopedDb } from "@/lib/db/scoped";
import { recomputeCommercials } from "@/modules/billing/service";
import { daysAgo, daysFromNow } from "./dates";
import { ids, seedId } from "./ids";
import { createRng } from "./random";
import { ROSTER, type AccountSpec } from "./roster";

/**
 * Contracts, subscriptions and invoices (docs/SEED_DATA.md §6). Revenue events, ARR and renewal
 * dates are NOT inserted: they are derived by the billing service's rules (D-28).
 */
interface ContractPlan {
  key: string;
  start: Date;
  end: Date | null;
  renewal: Date | null;
  value: number;
  status: "ACTIVE" | "ENDED";
}

const TERMS = (notice: number) =>
  `Annual subscription to Larkspur, billed in advance, payment due within 30 days. Renews for 12 months unless either party gives ${notice} days' written notice before the renewal date.`;

function contractPlans(a: AccountSpec, renewedIndex: number): ContractPlan[] {
  if (a.arrUsd === null) return []; // Fairhaven: no contract on file
  const v = a.arrUsd;
  if (a.churnedDaysAgo !== undefined) {
    // One two-year contract ending at the churn (D-52 seed correction: not also a renewal).
    const end = a.churnedDaysAgo;
    return [
      {
        key: "2",
        start: daysAgo(end + 730),
        end: daysAgo(end),
        renewal: daysAgo(end),
        value: v,
        status: "ENDED",
      },
    ];
  }
  if (a.renewalInDays === null) {
    // Kestrel: a contract with no renewal (or end) date on file.
    return [
      { key: "1", start: daysAgo(200), end: null, renewal: null, value: v, status: "ACTIVE" },
    ];
  }
  if (a.onboardingDay !== undefined) {
    const start = a.onboardingDay;
    return [
      {
        key: "1",
        start: daysAgo(start),
        end: daysFromNow(365 - start),
        renewal: daysFromNow(365 - start),
        value: v,
        status: "ACTIVE",
      },
    ];
  }
  if (renewedIndex < 0) {
    // Seed correction (D-52, founder decision 1): accounts outside SEED_DATA §8's 12 renewals are on
    // 2- or 3-year terms, so their data shows no renewal in the last year. Same renewal date as before.
    const years = a.key.length % 2 === 0 ? 2 : 3;
    return [
      {
        key: "2",
        start: daysAgo(years * 365 - a.renewalInDays),
        end: daysFromNow(a.renewalInDays),
        renewal: daysFromNow(a.renewalInDays),
        value: v,
        status: "ACTIVE",
      },
    ];
  }
  const startAgo = 365 - a.renewalInDays;
  // Renewed set (SEED_DATA §6/§8): 6 expansions, 3 contractions, the rest flat.
  const prior = renewedIndex < 6 ? Math.round(v * 0.8) : renewedIndex < 9 ? Math.round(v * 1.2) : v;
  return [
    {
      key: "1",
      start: daysAgo(startAgo + 365),
      end: daysAgo(startAgo),
      renewal: daysAgo(startAgo),
      value: prior,
      status: "ENDED",
    },
    {
      key: "2",
      start: daysAgo(startAgo),
      end: daysFromNow(a.renewalInDays),
      renewal: daysFromNow(a.renewalInDays),
      value: v,
      status: "ACTIVE",
    },
  ];
}

export async function seedCommercial(db: ScopedDb, workspaceId: string): Promise<void> {
  const cipher = fieldCipher();
  const rng = createRng(11);
  const renewed = ROSTER.filter((a) => a.renewedDaysAgo !== undefined).map((a) => a.key);
  const recoveredFailures = new Set(
    ROSTER.filter((a) => a.tier === "LONG_TAIL" && a.key.startsWith("gen-"))
      .slice(3, 5)
      .map((a) => a.key),
  );
  // Invoices are a time series: replaced wholesale on every run, with fixed ids (idempotent).
  await db.invoice.deleteMany({ where: { source: "SEED" } });
  const invoices: Prisma.InvoiceCreateManyInput[] = [];
  let invoiceNo = 1000;

  const plannedContracts = new Set<string>();
  const plannedSubscriptions = new Set<string>();
  for (const a of ROSTER) {
    const accountId = ids.account(a.key);
    const plans = contractPlans(a, renewed.indexOf(a.key));
    for (const p of plans) {
      plannedContracts.add(seedId(`contract:${a.key}:${p.key}`));
      plannedSubscriptions.add(seedId(`subscription:${a.key}:${p.key}`));
    }
    const monthly = a.plan === "Starter";
    for (const p of plans) {
      const contractId = seedId(`contract:${a.key}:${p.key}`);
      const contract = {
        accountId,
        startDate: p.start,
        endDate: p.end,
        renewalDate: p.renewal,
        autoRenew: a.tier === "LONG_TAIL",
        noticePeriodDays: a.noticePeriodDays,
        valueMinor: BigInt(p.value * 100),
        currency: "USD",
        seatsPurchased:
          p.key === "2" || plans.length === 1 ? a.seats : Math.max(1, Math.round(p.value / 900)),
        termsEnc: cipher.encrypt(TERMS(a.noticePeriodDays)),
        pricingNotesEnc:
          a.tier === "HIGH_TOUCH"
            ? cipher.encrypt("List price $900 per seat per year; 8% volume discount applied.")
            : null,
        status: p.status,
        source: "SEED" as const,
      };
      await db.contract.upsert({
        where: { id: contractId },
        create: { id: contractId, workspaceId, ...contract },
        update: contract,
      });

      const subscriptionId = seedId(`subscription:${a.key}:${p.key}`);
      const amount = BigInt(Math.round((p.value * 100) / (monthly ? 12 : 1)));
      const subscription = {
        accountId,
        contractId,
        plan: a.plan,
        interval: monthly ? ("MONTH" as const) : ("YEAR" as const),
        amountMinor: amount,
        currency: "USD",
        quantity: contract.seatsPurchased ?? 1,
        status: p.status === "ACTIVE" ? ("ACTIVE" as const) : ("ENDED" as const),
        currentPeriodEnd: p.end,
        source: "SEED" as const,
      };
      await db.subscription.upsert({
        where: { id: subscriptionId },
        create: { id: subscriptionId, workspaceId, ...subscription },
        update: subscription,
      });

      // Invoices: one per year, or one per month for monthly plans, up to SEED_TODAY.
      const stepDays = monthly ? 30 : 365;
      for (
        let t = p.start.getTime();
        t <= daysAgo(0).getTime() && (!p.end || t < p.end.getTime());
        t += stepDays * 86_400_000
      ) {
        const issuedAt = new Date(t);
        const dueAt = new Date(t + 30 * 86_400_000);
        invoices.push({
          id: seedId(`invoice:${a.key}:${invoiceNo}`),
          workspaceId,
          accountId,
          subscriptionId,
          number: `LRK-${invoiceNo++}`,
          amountMinor: amount,
          currency: "USD",
          issuedAt,
          dueAt,
          paidAt: dueAt <= daysAgo(0) ? new Date(t + rng.int(2, 25) * 86_400_000) : null,
          status: dueAt <= daysAgo(0) ? "PAID" : "OPEN",
          source: "SEED",
        });
      }
    }
    if (a.key === "northgate") {
      // An add-on invoice paid 21 days late, two months ago (SEED_DATA §6).
      invoices.push({
        id: seedId("invoice:northgate:addon"),
        workspaceId,
        accountId,
        number: `LRK-${invoiceNo++}`,
        amountMinor: 1_800_000n,
        currency: "USD",
        issuedAt: daysAgo(90),
        dueAt: daysAgo(60),
        paidAt: daysAgo(39),
        status: "PAID",
        source: "SEED",
      });
    }
  }

  // Planted payment failures on the newest invoice of each story account.
  const newest = (key: string) =>
    invoices
      .filter((i) => i.accountId === ids.account(key))
      .sort((x, y) => +new Date(y.issuedAt) - +new Date(x.issuedAt))[0]!;
  Object.assign(newest("sundial"), {
    status: "FAILED",
    paidAt: null,
    failureCount: 2,
    lastFailedAt: daysAgo(3),
    dueAt: daysAgo(3),
  });
  Object.assign(newest("orchard-lane"), {
    status: "FAILED",
    paidAt: null,
    failureCount: 1,
    lastFailedAt: daysAgo(1),
    dueAt: daysAgo(1),
  });
  for (const key of recoveredFailures) {
    const inv = newest(key);
    Object.assign(inv, {
      status: "PAID",
      failureCount: 1,
      lastFailedAt: new Date(+inv.dueAt - 86_400_000),
    });
  }
  const failingChurn = ROSTER.find((a) => a.story?.includes("payment failures"));
  if (failingChurn) {
    invoices
      .filter((i) => i.accountId === ids.account(failingChurn.key))
      .sort((x, y) => +new Date(y.issuedAt) - +new Date(x.issuedAt))
      .slice(0, 3)
      .forEach((i, n) =>
        Object.assign(i, {
          status: n === 0 ? "UNCOLLECTIBLE" : "FAILED",
          paidAt: null,
          failureCount: 3 - n,
        }),
      );
  }
  // A re-seed removes seeded contracts the plan no longer has (D-52 seed correction).
  await db.subscription.deleteMany({
    where: { source: "SEED", id: { notIn: [...plannedSubscriptions] } },
  });
  await db.contract.deleteMany({ where: { source: "SEED", id: { notIn: [...plannedContracts] } } });
  for (let i = 0; i < invoices.length; i += 500) {
    await db.invoice.createMany({ data: invoices.slice(i, i + 500) });
  }

  await db.$tenantTransaction(async (tx) => {
    for (const a of ROSTER)
      await recomputeCommercials(tx, workspaceId, ids.account(a.key), daysAgo(0));
  });
}
