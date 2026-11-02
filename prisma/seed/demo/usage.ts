import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ScopedDb } from "@/lib/db/scoped";
import { dayKey } from "./dates";
import { ids, seedId } from "./ids";
import { createRng, type Rng } from "./random";
import { ROSTER, type AccountSpec } from "./roster";

/**
 * Usage time series (docs/SEED_DATA.md §4): 365 days of account-level rows, 90 days of user-
 * and feature-level rows. Shapes are generated, then the planted stories are applied on top.
 * Series are replaced wholesale on every run with fixed ids (idempotent, D-28).
 */
export const FEATURES = [
  {
    key: "dashboards",
    label: "Dashboards",
    isKey: true,
    plans: ["Starter", "Growth", "Scale", "Enterprise"],
    rate: 0.8,
  },
  {
    key: "scheduled_reports",
    label: "Scheduled reports",
    isKey: true,
    plans: ["Starter", "Growth", "Scale", "Enterprise"],
    rate: 0.45,
  },
  {
    key: "alerts",
    label: "Alerts",
    isKey: true,
    plans: ["Starter", "Growth", "Scale", "Enterprise"],
    rate: 0.3,
  },
  {
    key: "csv_export",
    label: "CSV export",
    isKey: false,
    plans: ["Starter", "Growth", "Scale", "Enterprise"],
    rate: 0.2,
  },
  {
    key: "data_connectors",
    label: "Data connectors",
    isKey: true,
    plans: ["Growth", "Scale", "Enterprise"],
    rate: 0.15,
  },
  {
    key: "api_access",
    label: "API access",
    isKey: false,
    plans: ["Growth", "Scale", "Enterprise"],
    rate: 0.1,
  },
  { key: "sso", label: "Single sign-on", isKey: false, plans: ["Scale", "Enterprise"], rate: 0.05 },
  { key: "audit_trail", label: "Audit trail", isKey: false, plans: ["Enterprise"], rate: 0.05 },
] as const;

const USER_DAYS = 90;
const ACCOUNT_DAYS = 365;
const MAX_USERS = 60;

const rngFor = (key: string): Rng =>
  createRng(parseInt(createHash("sha1").update(key).digest("hex").slice(0, 8), 16));

/** Days-ago window in which the account existed as a customer (inclusive). */
function window(a: AccountSpec): { from: number; to: number } {
  if (a.churnedDaysAgo !== undefined) return { from: a.churnedDaysAgo + 180, to: a.churnedDaysAgo };
  if (a.onboardingDay !== undefined) return { from: a.onboardingDay, to: 0 };
  return { from: ACCOUNT_DAYS - 1, to: 0 };
}

function baseUsers(a: AccountSpec, rng: Rng): number {
  if (a.key === "brightwell") return 41;
  if (a.key === "copperleaf") return 36;
  if (a.key === "pinecrest") return 3;
  const util = a.tier === "HIGH_TOUCH" ? 0.3 + rng.next() * 0.3 : 0.45 + rng.next() * 0.4;
  return Math.max(1, Math.min(MAX_USERS, Math.round(a.seats * util)));
}

/** Story shapes on top of the base level; returns the multiplier or an absolute override. */
function shape(a: AccountSpec, daysAgo: number, base: number, rng: Rng): number {
  let users = base * (0.92 + rng.next() * 0.16);
  const ramp = (start: number, len: number, from: number, to: number) =>
    daysAgo <= start && daysAgo > start - len
      ? from + ((to - from) * (start - daysAgo)) / len
      : null;
  switch (a.key) {
    case "brightwell": {
      const r = ramp(35, 35, 41, 17);
      if (daysAgo < 35) users = (r ?? 17) * (0.95 + rng.next() * 0.1);
      break;
    }
    case "copperleaf":
      if (daysAgo < 21) users = 52;
      break;
    case "redfern":
      if (daysAgo < 24) users = 0;
      break;
    case "cobalt-ridge":
      if (daysAgo < 9) users = 0;
      break;
    case "juniper-vet":
      users = base * Math.min(1, (61 - daysAgo) / 20);
      break;
    case "lumen":
      users = base * Math.min(0.5, (75 - daysAgo) / 120);
      break;
  }
  if (a.onboardingDay !== undefined && !["juniper-vet", "lumen"].includes(a.key)) {
    users *= Math.min(1, (a.onboardingDay - daysAgo + 3) / 21);
  }
  if (a.churnedDaysAgo !== undefined && a.story?.includes("usage drop")) {
    const before = daysAgo - a.churnedDaysAgo;
    if (before < 75) users *= Math.max(0.2, before / 75);
  }
  if (a.story?.includes("temporary dip") && a.renewedDaysAgo !== undefined) {
    const d = daysAgo - a.renewedDaysAgo;
    if (d >= 40 && d <= 60) users *= 0.55;
  }
  return Math.max(0, users);
}

export async function seedUsage(db: ScopedDb, workspaceId: string): Promise<void> {
  for (const f of FEATURES) {
    const data = { label: f.label, isKeyFeature: f.isKey, includedInPlans: [...f.plans] };
    await db.featureCatalog.upsert({
      where: { workspaceId_featureKey: { workspaceId, featureKey: f.key } },
      create: { id: seedId(`feature:${f.key}`), workspaceId, featureKey: f.key, ...data },
      update: data,
    });
  }
  await db.usageDaily.deleteMany({ where: { source: "SEED" } });
  await db.userUsageDaily.deleteMany({ where: { source: "SEED" } });
  await db.featureUsageDaily.deleteMany({ where: { source: "SEED" } });

  const daily: Prisma.UsageDailyCreateManyInput[] = [];
  const perUser: Prisma.UserUsageDailyCreateManyInput[] = [];
  const perFeature: Prisma.FeatureUsageDailyCreateManyInput[] = [];

  for (const a of ROSTER) {
    const rng = rngFor(a.key);
    const accountId = ids.account(a.key);
    const base = baseUsers(a, rng);
    const { from, to } = window(a);
    // People: known contacts first (so their activity is attributable), then anonymous users.
    const contactUsers = a.contacts
      .filter((c) => !c.key.endsWith("-dup") && c.key !== "ken-inc")
      .map((c) => ({
        externalUserId: `${a.key}:${c.key}`,
        contactId: ids.contact(a.key, c.key),
      }));
    const maxUsers = Math.max(base, a.key === "copperleaf" ? 52 : 0);
    const people = [
      ...contactUsers,
      ...Array.from({ length: Math.max(0, maxUsers - contactUsers.length) }, (_, i) => ({
        externalUserId: `${a.key}:u${i}`,
        contactId: null,
      })),
    ];
    const recent: number[] = [];
    for (let d = from; d >= to; d--) {
      const date = dayKey(d);
      const weekday = date.getUTCDay();
      const weekendFactor = weekday === 0 || weekday === 6 ? 0.25 : 1;
      const active = Math.min(people.length, Math.round(shape(a, d, base, rng) * weekendFactor));
      recent.push(active);
      if (recent.length > 28) recent.shift();
      daily.push({
        id: seedId(`ud:${a.key}:${d}`),
        workspaceId,
        accountId,
        date,
        activeUsers: active,
        sessions: Math.round(active * (1.3 + rng.next())),
        events: Math.round(active * (18 + rng.next() * 12)),
        seatsUsed: Math.min(people.length, Math.round(Math.max(...recent) * 1.1)),
        source: "SEED",
      });
      if (d >= USER_DAYS) continue;
      let todaysPeople = people.slice(0, active);
      // Brightwell's top power user (Maya) goes quiet 40 days ago (SEED_DATA §4).
      if (a.key === "brightwell" && d < 40)
        todaysPeople = people.filter((p) => !p.externalUserId.endsWith(":maya")).slice(0, active);
      todaysPeople.forEach((p, i) => {
        const power = i < Math.max(1, Math.round(people.length * 0.1));
        perUser.push({
          id: seedId(`uud:${p.externalUserId}:${d}`),
          workspaceId,
          accountId,
          contactId: p.contactId,
          externalUserId: p.externalUserId,
          date,
          events: power ? 40 + rng.int(0, 30) : 5 + rng.int(0, 15),
          sessions: power ? 3 + rng.int(0, 2) : 1,
          source: "SEED",
        });
      });
      for (const f of FEATURES) {
        if (!(f.plans as readonly string[]).includes(a.plan)) continue;
        if (f.key === "data_connectors" && ["pinecrest", "ostara"].includes(a.key)) continue;
        if (f.key === "scheduled_reports" && a.key === "brightwell" && d < 19) continue;
        if (a.key === "pinecrest" && !["dashboards", "csv_export"].includes(f.key)) continue;
        const users = Math.round(active * f.rate * (0.8 + rng.next() * 0.4));
        if (users === 0) continue;
        perFeature.push({
          id: seedId(`fud:${a.key}:${f.key}:${d}`),
          workspaceId,
          accountId,
          featureKey: f.key,
          date,
          users,
          events: users * (3 + rng.int(0, 6)),
          source: "SEED",
        });
      }
    }
  }
  const insert = async <T>(rows: T[], write: (chunk: T[]) => Promise<unknown>) => {
    for (let i = 0; i < rows.length; i += 5000) await write(rows.slice(i, i + 5000));
  };
  await insert(daily, (data) => db.usageDaily.createMany({ data }));
  await insert(perUser, (data) => db.userUsageDaily.createMany({ data }));
  await insert(perFeature, (data) => db.featureUsageDaily.createMany({ data }));
}
