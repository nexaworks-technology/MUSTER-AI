/**
 * Muster Demo workspace (docs/DEMO-WALKTHROUGH.md): ONE fictional workspace that shows every feature.
 * Not product code; run by hand against a target database:
 *
 *   pnpm exec tsx --env-file=<env file> scripts/demo-workspace.ts [--skip-ai]
 *
 * CREATE-ONLY (same pattern as scripts/proof-workspace.ts): refuses to run if the workspace slug or
 * any of its three login emails already exists. It never updates, wipes or reseeds anything, and no
 * other workspace is read or written. Refused in production unless ALLOW_DEMO_SEED=true.
 *
 * SEEDED THROUGH THE PRODUCT: the script writes RAW INPUTS only. Accounts, contacts, billing, tickets,
 * mail and meetings go through the integrations ingest path (`ingestBatch`, the code a connector
 * sync uses, so provenance, matching, conflicts and the Unmatched queue are the product's own); seat
 * counts, usage, stakeholder roles, surveys and onboarding plans are written as the raw rows a
 * connector or a person would create. It then runs the product's pipelines: the nightly signals and
 * health pass, the Watcher, the outbox dispatcher (plays), the drafting agents, the QBR and
 * pre-call brief, and the weekly digest. No health score, signal, approval or AI text is written here.
 *
 * AI: with --skip-ai nothing calls a model. Otherwise the agents run in real time against the
 * configured provider (a provider without the Batch API, so results land now), for a short fixed
 * list of story accounts; the workspace's monthly token budget is capped at 3M tokens.
 * No connector is called: the Integration rows are created without credentials.
 */
import { Worker } from "bullmq";
import type { Prisma } from "@prisma/client";
import { getAiProvider, type AiProvider } from "@/lib/ai";
import { writeAudit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { fieldCipher } from "@/lib/crypto";
import { todayIn, type Clock } from "@/lib/dates";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { dispatchOutbox, OUTBOX_ROUTES } from "@/lib/jobs/outbox";
import { closeQueues, getQueue, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import { recomputeLastTouch } from "@/modules/accounts/service";
import {
  healthAnalyst,
  outreach,
  runAgent,
  watcher,
  askExpansionFinder,
  sweepRenewalAgents,
  sweepExpansionAgents,
} from "@/modules/agents/service";
import { recomputeCommercials } from "@/modules/billing/service";
import { triggerIdFor } from "@/modules/conversations/service";
import { displayedSnapshot, getActiveModel } from "@/modules/health/service";
import { syncInbox } from "@/modules/inbox/service";
import {
  ingestBatch,
  type IngestTarget,
  type NormalizedKind,
} from "@/modules/integrations/service";
import { prepareBrief } from "@/modules/meetings/service";
import { onOnboardingStalled, sweepOnboardingAgents } from "@/modules/onboarding/service";
import { processPlaySignalOpened, publishPlay } from "@/modules/plays/service";
import { generateQbr } from "@/modules/qbr/service";
import { runWeeklyDigest } from "@/modules/reports/service";
import type { Actor } from "@/modules/settings/service";
import { runNightlyInline, syncSignalRules } from "@/modules/signals/service";
import { seedPlaysForWorkspace } from "@/modules/plays/service";
import { processorFor } from "@/worker/processors";
import { DEMO_PASSWORD } from "../prisma/seed/users";
import { FEATURES } from "../prisma/seed/demo/usage";
import { createRng } from "../prisma/seed/demo/random";
import {
  ALL_ACCOUNTS,
  emailOf,
  story,
  type AccountSpec,
  type OwnerKey,
} from "./demo-workspace/story";

const WORKSPACE = {
  name: "Muster Demo",
  slug: "muster-demo",
  timezone: "America/New_York",
  baseCurrency: "USD",
} as const;

const USERS = [
  {
    key: "admin",
    name: "Rhea Kapoor",
    email: "admin@muster-demo.test",
    role: "ADMIN",
    canViewRevenue: true,
    bookScope: "ALL",
  },
  {
    key: "marcus",
    name: "Marcus Hale",
    email: "leader@muster-demo.test",
    role: "CS_LEADER",
    canViewRevenue: true,
    bookScope: "ALL",
  },
  {
    key: "jonah",
    name: "Jonah Reyes",
    email: "csm@muster-demo.test",
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  },
] as const;
type UserKey = (typeof USERS)[number]["key"];

const SKIP_AI = process.argv.includes("--skip-ai");

// ─── Dates: everything relative to the moment the script runs ────────────────
const NOW = new Date();
const clock: Clock = () => new Date();
const TODAY = todayIn(WORKSPACE.timezone, () => NOW);
const DAY = 86_400_000;
/** An hour before now, so "today" records are never in the future. */
const BASE = NOW.getTime() - 3_600_000;
const daysAgo = (n: number, hourShift = 0) => new Date(BASE - n * DAY + hourShift * 3_600_000);
const daysFromNow = (n: number) => new Date(BASE + n * DAY);
const dayKey = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - n * DAY);
const dayStr = (n: number) => dayKey(n).toISOString().slice(0, 10);

const log = (...a: unknown[]) => console.log(...a);
const json = (v: unknown) => v as Prisma.InputJsonValue;

// ─── Setup ───────────────────────────────────────────────────────────────────
async function refuseIfExists() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true")
    throw new Error("Refusing to create demo data in production (set ALLOW_DEMO_SEED=true).");
  const ws = await rawDb.workspace.findUnique({ where: { slug: WORKSPACE.slug } });
  if (ws) throw new Error(`Workspace "${WORKSPACE.slug}" already exists; refusing (create-only).`);
  const users = await rawDb.user.findMany({
    where: { email: { in: USERS.map((u) => u.email) } },
    select: { email: true },
  });
  if (users.length)
    throw new Error(
      `User ${users.map((u) => u.email).join(", ")} already exists; refusing (create-only).`,
    );
}

interface Tenancy {
  ctx: TenantContext;
  members: Record<UserKey, string>;
  actors: Record<UserKey, Actor>;
}

async function createTenancy(): Promise<Tenancy> {
  const workspace = await rawDb.workspace.create({ data: { ...WORKSPACE, setupPending: false } });
  const ctx = { workspaceId: workspace.id };
  const db = scopedDb(ctx);
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const members = {} as Record<UserKey, string>;
  const actors = {} as Record<UserKey, Actor>;
  for (const u of USERS) {
    const user = await rawDb.user.create({
      data: { email: u.email, name: u.name, passwordHash, emailVerified: NOW },
    });
    const m = await db.membership.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        role: u.role,
        canViewRevenue: u.canViewRevenue,
        bookScope: u.bookScope,
        status: "ACTIVE",
      },
    });
    members[u.key] = m.id;
    actors[u.key] = {
      workspaceId: workspace.id,
      userId: user.id,
      membershipId: m.id,
      role: u.role,
      canViewRevenue: u.canViewRevenue,
      bookScope: u.bookScope,
      user: { id: user.id, email: u.email, name: u.name },
    } as Actor;
  }
  // A hard ceiling on AI spend for this demo workspace (the product's own monthly budget).
  await db.workspaceSettings.create({
    data: { workspaceId: workspace.id, data: { ai: { monthlyTokenBudget: 3_000_000 } } },
  });
  await seedPlaysForWorkspace(workspace.id);
  await syncSignalRules(ctx);
  await getActiveModel(ctx);
  for (const f of FEATURES) {
    await db.featureCatalog.create({
      data: {
        workspaceId: workspace.id,
        featureKey: f.key,
        label: f.label,
        isKeyFeature: f.isKey,
        includedInPlans: [...f.plans],
      },
    });
  }
  await writeAudit({
    workspaceId: workspace.id,
    actorType: "SYSTEM",
    action: "demo.workspace.created",
    summary: "Muster Demo workspace created (create-only script, fictional data)",
  });
  log(`created workspace "${WORKSPACE.name}" (${WORKSPACE.slug}) ${workspace.id}, as of ${TODAY}`);
  return { ctx, members, actors };
}

const PROVIDERS = [
  "HUBSPOT",
  "SALESFORCE",
  "STRIPE",
  "ZENDESK",
  "GOOGLE_EMAIL",
  "GOOGLE_CALENDAR",
  "MIXPANEL",
] as const;
type Provider = (typeof PROVIDERS)[number];

async function createIntegrations(t: Tenancy): Promise<Record<Provider, IngestTarget>> {
  const db = scopedDb(t.ctx);
  const out = {} as Record<Provider, IngestTarget>;
  for (const provider of PROVIDERS) {
    // No credentials: these rows only give the seeded records a real source. Nothing can sync.
    const row = await db.integration.create({
      data: {
        workspaceId: t.ctx.workspaceId,
        provider,
        status: "CONNECTED",
        externalAccountId: `muster-demo-${provider.toLowerCase()}`,
        connectedByMembershipId: t.members.admin,
        connectedAt: daysAgo(210),
        lastSyncAt: daysAgo(0),
      },
    });
    out[provider] = {
      workspaceId: t.ctx.workspaceId,
      integrationId: row.id,
      source: provider === "GOOGLE_EMAIL" ? "GMAIL" : provider,
    };
  }
  return out;
}

async function ingest(target: IngestTarget, kind: NormalizedKind, records: unknown[]) {
  if (!records.length) return;
  const r = await ingestBatch(target, { kind, records });
  const c = r.counts;
  log(
    `  ingest ${target.source} ${kind}: ${c.created} created, ${c.updated} updated, ${c.rejected} rejected, ${c.unmatched} unmatched, ${c.conflicts} conflicts`,
  );
  for (const p of r.problems) log(`    ${p.kind} ${p.objectType}: ${p.reason}`);
  if (c.rejected) throw new Error(`ingest rejected ${c.rejected} ${kind} record(s); fix the seed`);
}

// ─── CRM: accounts, contacts, roles, contracts ──────────────────────────────
const MEMBER_EMAIL: Record<Exclude<OwnerKey, null>, string> = {
  jonah: "csm@muster-demo.test",
  marcus: "leader@muster-demo.test",
};
const hsCompany = (a: AccountSpec) => `hs-co-${a.key}`;

async function seedCrm(t: Tenancy, it: Record<Provider, IngestTarget>) {
  await ingest(it.HUBSPOT, "owners", [
    { externalId: "hs-owner-jonah", email: MEMBER_EMAIL.jonah, name: "Jonah Reyes" },
    { externalId: "hs-owner-marcus", email: MEMBER_EMAIL.marcus, name: "Marcus Hale" },
  ]);
  await ingest(
    it.HUBSPOT,
    "accounts",
    ALL_ACCOUNTS.map((a) => ({
      externalId: hsCompany(a),
      name: a.name,
      domain: a.domain,
      ownerExternalId: a.owner ? `hs-owner-${a.owner}` : undefined,
      industry: a.industry,
      employeeBand: a.employeeBand,
      plan: a.plan,
      timezone: WORKSPACE.timezone,
    })),
  );
  await ingest(
    it.HUBSPOT,
    "contacts",
    ALL_ACCOUNTS.flatMap((a) =>
      a.people.map((p) => ({
        externalId: `hs-ct-${a.key}-${p.key}`,
        accountExternalId: hsCompany(a),
        name: p.name,
        email: emailOf(a, p),
        title: p.title,
      })),
    ),
  );
  // Story 11: Salesforce holds the same company (same domain) with a different industry and size.
  const ashby = story("ashby-mercer");
  await ingest(it.SALESFORCE, "accounts", [
    {
      externalId: "sf-001-ashby",
      name: ashby.name,
      domain: ashby.domain,
      industry: "Freight forwarding",
      employeeBand: "51-200",
    },
  ]);

  const db = scopedDb(t.ctx);
  const accounts = await db.account.findMany({ select: { id: true, domain: true } });
  const idOf = new Map(accounts.map((a) => [a.domain, a.id]));
  const contacts = await db.contact.findMany({ select: { id: true, email: true } });
  const contactOf = new Map(contacts.map((c) => [c.email!.toLowerCase(), c.id]));
  const cipher = fieldCipher();

  for (const a of ALL_ACCOUNTS) {
    const accountId = idOf.get(a.domain)!;
    // Lifecycle facts the CRM holds (stage, onboarding start, churn date).
    await db.account.update({
      where: { id: accountId },
      data: {
        lifecycleStage: a.stage,
        stageChangedAt: daysAgo(a.churnedDaysAgo ?? a.onboardingDay ?? 120),
        onboardingStartedAt: a.onboardingDay !== undefined ? daysAgo(a.onboardingDay) : null,
        churnedAt: a.churnedDaysAgo !== undefined ? daysAgo(a.churnedDaysAgo) : null,
      },
    });
    for (const p of a.people) {
      const contactId = contactOf.get(emailOf(a, p).toLowerCase())!;
      if (p.status && p.status !== "ACTIVE")
        await db.contact.update({
          where: { id: contactId },
          data: { status: p.status, statusChangedAt: daysAgo(p.statusDaysAgo ?? 0) },
        });
      for (const r of p.roles ?? [])
        await db.stakeholderRole.create({
          data: {
            workspaceId: t.ctx.workspaceId,
            accountId,
            contactId,
            role: r.role,
            validFrom: daysAgo(r.fromDaysAgo),
            origin: "HUMAN",
          },
        });
    }
    // The contract in force (the CRM deal): seats, value, renewal, notice period.
    const ended = a.churnedDaysAgo !== undefined;
    const renewal = ended ? daysAgo(a.churnedDaysAgo!) : daysFromNow(a.renewalInDays);
    const start =
      a.onboardingDay !== undefined
        ? daysAgo(a.onboardingDay)
        : a.upgradedDaysAgo !== undefined
          ? daysAgo(a.upgradedDaysAgo)
          : new Date(renewal.getTime() - (a.renewalInDays > 200 ? 2 : 1) * 365 * DAY);
    // Story 4: the contract Lindqvist upgraded from mid-term (fewer seats, lower value).
    if (a.upgradedDaysAgo !== undefined)
      await db.contract.create({
        data: {
          workspaceId: t.ctx.workspaceId,
          accountId,
          startDate: new Date(start.getTime() - 400 * DAY),
          endDate: start,
          renewalDate: start,
          noticePeriodDays: a.noticePeriodDays,
          valueMinor: BigInt(a.priorArrUsd! * 100),
          currency: "USD",
          seatsPurchased: a.priorSeats!,
          status: "ENDED",
          source: "HUBSPOT",
        },
      });
    await db.contract.create({
      data: {
        workspaceId: t.ctx.workspaceId,
        accountId,
        startDate: start,
        endDate: renewal,
        renewalDate: renewal,
        autoRenew: a.plan === "Starter",
        noticePeriodDays: a.noticePeriodDays,
        valueMinor: BigInt(a.arrUsd * 100),
        currency: "USD",
        seatsPurchased: a.seats,
        termsEnc: cipher.encrypt(
          `Subscription billed in advance, payment due within 30 days. Renews for 12 months unless either party gives ${a.noticePeriodDays} days' written notice.`,
        ),
        status: ended ? "ENDED" : "ACTIVE",
        source: "HUBSPOT",
      },
    });
  }
  return { idOf, contactOf };
}

// ─── Billing (Stripe): customers, subscriptions, invoices ───────────────────
async function seedBilling(t: Tenancy, it: Record<Provider, IngestTarget>) {
  await ingest(
    it.STRIPE,
    "customers",
    ALL_ACCOUNTS.map((a) => ({ externalId: `cus_${a.key}`, name: a.name, domain: a.domain })),
  );
  const subs: unknown[] = [];
  const invoices: unknown[] = [];
  let n = 4100;
  for (const a of ALL_ACCOUNTS) {
    const monthly = a.plan === "Starter";
    const lost = a.churnedDaysAgo !== undefined;
    const amount = monthly ? Math.round((a.arrUsd * 100) / 12) : a.arrUsd * 100;
    subs.push({
      externalId: `sub_${a.key}`,
      customerExternalId: `cus_${a.key}`,
      plan: a.plan,
      interval: monthly ? "MONTH" : "YEAR",
      amountMinor: amount,
      currency: "USD",
      quantity: a.seats,
      status: lost ? "CANCELLED" : "ACTIVE",
      currentPeriodEnd: lost
        ? daysAgo(a.churnedDaysAgo!)
        : daysFromNow(monthly ? 12 : a.renewalInDays),
    });
    // Invoices: monthly plans for six months, annual plans for the last two years.
    const issued = monthly
      ? [150, 120, 90, 60, 30, 0].map((d) => d + 2)
      : [365 - a.renewalInDays, 730 - a.renewalInDays].filter((d) => d >= 0 && d < 800);
    for (const d of issued) {
      if (lost && d < a.churnedDaysAgo!) continue;
      const due = d - 30;
      // Long tail: the newest monthly charge that fell due failed.
      const failed = a.failedInvoice && due > 0 && due < 30;
      invoices.push({
        externalId: `in_${a.key}_${n}`,
        customerExternalId: `cus_${a.key}`,
        subscriptionExternalId: `sub_${a.key}`,
        number: `MDM-${n++}`,
        amountMinor: amount,
        currency: "USD",
        issuedAt: daysAgo(d),
        dueAt: due > 0 ? daysAgo(due) : daysFromNow(-due),
        ...(due > 0 && !failed ? { paidAt: daysAgo(Math.max(0, due + 5)) } : {}),
        status: failed ? "FAILED" : due > 0 ? "PAID" : "OPEN",
        ...(failed ? { failureCount: 1, lastFailedAt: daysAgo(1) } : {}),
      });
    }
  }
  // Story 4: the prorated invoice for Lindqvist's mid-term upgrade from 80 to 100 seats.
  const lq = story("lindqvist");
  const prorated = Math.round(
    ((lq.arrUsd - lq.priorArrUsd!) * 100 * (lq.renewalInDays + lq.upgradedDaysAgo!)) / 365,
  );
  invoices.push({
    externalId: "in_lindqvist_upgrade",
    customerExternalId: `cus_${lq.key}`,
    subscriptionExternalId: `sub_${lq.key}`,
    number: `MDM-${n++}`,
    amountMinor: prorated,
    currency: "USD",
    issuedAt: daysAgo(lq.upgradedDaysAgo!),
    dueAt: daysAgo(lq.upgradedDaysAgo! - 30),
    paidAt: daysAgo(lq.upgradedDaysAgo! - 26),
    status: "PAID",
  });
  // Story 8: Saltire adds a monthly data add-on on its own plan and quantity, with one failed charge.
  const s = story("saltire");
  subs.push({
    externalId: "sub_saltire_addon",
    customerExternalId: "cus_saltire",
    plan: "Data connectors add-on",
    interval: "MONTH",
    amountMinor: 45_000,
    currency: "USD",
    quantity: 12,
    status: "PAST_DUE",
    currentPeriodEnd: daysFromNow(9),
  });
  for (const [d, status] of [
    [95, "PAID"],
    [65, "PAID"],
    [36, "FAILED"],
    [5, "OPEN"],
  ] as const) {
    invoices.push({
      externalId: `in_saltire_addon_${d}`,
      customerExternalId: `cus_${s.key}`,
      subscriptionExternalId: "sub_saltire_addon",
      number: `MDM-${n++}`,
      amountMinor: 45_000,
      currency: "USD",
      issuedAt: daysAgo(d),
      dueAt: d - 30 > 0 ? daysAgo(d - 30) : daysFromNow(30 - d),
      ...(status === "PAID" ? { paidAt: daysAgo(d - 3) } : {}),
      status,
      ...(status === "FAILED" ? { failureCount: 2, lastFailedAt: daysAgo(3) } : {}),
    });
  }
  await ingest(it.STRIPE, "subscriptions", subs);
  await ingest(it.STRIPE, "invoices", invoices);

  const db = scopedDb(t.ctx);
  const accounts = await db.account.findMany({ select: { id: true } });
  await db.$tenantTransaction(async (tx) => {
    for (const a of accounts) await recomputeCommercials(tx, t.ctx.workspaceId, a.id, NOW);
  });
}

// ─── Product usage (Mixpanel): daily account, user and feature rows ──────────
const ACCOUNT_DAYS = 200;
const USER_DAYS = 90;

async function seedUsage(
  t: Tenancy,
  idOf: Map<string | null, string>,
  contactOf: Map<string, string>,
) {
  const db = scopedDb(t.ctx);
  const daily: Prisma.UsageDailyCreateManyInput[] = [];
  const perUser: Prisma.UserUsageDailyCreateManyInput[] = [];
  const perFeature: Prisma.FeatureUsageDailyCreateManyInput[] = [];
  const ws = t.ctx.workspaceId;
  for (const [ai, a] of ALL_ACCOUNTS.entries()) {
    const rng = createRng(1000 + ai);
    const accountId = idOf.get(a.domain)!;
    let peak = 0;
    for (let d = 0; d < ACCOUNT_DAYS; d++) peak = Math.max(peak, a.users(d));
    const named = a.people
      .filter((p) => p.status !== "BOUNCED")
      .map((p) => ({
        externalUserId: `${a.key}:${p.key}`,
        contactId: contactOf.get(emailOf(a, p).toLowerCase()) ?? null,
        from: p.firstActiveDaysAgo ?? Infinity,
        to: p.lastActiveDaysAgo ?? -1,
      }));
    const anonymous = Array.from(
      { length: Math.max(0, Math.ceil(peak) - named.length + 2) },
      (_, i) => ({
        externalUserId: `${a.key}:u${i}`,
        contactId: null as string | null,
        from: Infinity,
        to: -1,
      }),
    );
    // Named people who join later (Lindqvist's Research team) are counted on top of the base.
    const late = named.filter((p) => p.from !== Infinity);
    const regular = [...named.filter((p) => p.from === Infinity), ...anonymous];
    // Power users are a stable set (the first tenth of the people), so their quiet is visible.
    const powerCount = Math.max(1, Math.round(regular.length * 0.1));
    const isPower = new Set(regular.slice(0, powerCount).map((p) => p.externalUserId));
    const normal = a.users(USER_DAYS);
    const recent: number[] = [];
    const start =
      a.onboardingDay !== undefined
        ? Math.min(ACCOUNT_DAYS - 1, a.onboardingDay)
        : ACCOUNT_DAYS - 1;
    for (let d = start; d >= 0; d--) {
      const date = dayKey(d);
      const weekday = date.getUTCDay();
      const factor = weekday === 0 || weekday === 6 ? 0.25 : 1;
      const want = Math.max(0, Math.round(a.users(d) * factor * (0.94 + rng.next() * 0.12)));
      const lateToday = late.filter((p) => d <= p.from && d > p.to);
      const lateActive =
        factor === 1 ? lateToday : lateToday.slice(0, Math.ceil(lateToday.length / 4));
      const pool = regular.filter((p) => d > p.to);
      const take = Math.max(0, want - lateActive.length);
      // In a decline the heaviest users stop first: take today's people from the other end.
      const declining = a.powerUsersQuit && a.users(d) < 0.85 * normal;
      const chosen = declining ? pool.slice(Math.max(0, pool.length - take)) : pool.slice(0, take);
      const people = [...chosen, ...lateActive];
      const active = people.length;
      recent.push(active);
      if (recent.length > 28) recent.shift();
      daily.push({
        workspaceId: ws,
        accountId,
        date,
        activeUsers: active,
        sessions: Math.round(active * (1.3 + rng.next())),
        events: Math.round(active * (18 + rng.next() * 12)),
        seatsUsed: Math.min(regular.length + late.length, Math.round(Math.max(...recent) * 1.05)),
        source: "MIXPANEL",
      });
      if (d >= USER_DAYS) continue;
      people.forEach((p) => {
        const power = isPower.has(p.externalUserId);
        perUser.push({
          workspaceId: ws,
          accountId,
          contactId: p.contactId,
          externalUserId: p.externalUserId,
          date,
          events: power ? 40 + rng.int(0, 30) : 5 + rng.int(0, 15),
          sessions: power ? 3 + rng.int(0, 2) : 1,
          source: "MIXPANEL",
        });
      });
      for (const f of FEATURES) {
        if (!(f.plans as readonly string[]).includes(a.plan)) continue;
        // Tamsin has not connected a data source yet (onboarding step in progress).
        if (a.key === "tamsin" && f.key === "data_connectors") continue;
        if (a.stoppedFeatures?.includes(f.key) && d < 30) continue;
        const users = Math.round(active * f.rate * (0.8 + rng.next() * 0.4));
        if (users === 0) continue;
        perFeature.push({
          workspaceId: ws,
          accountId,
          featureKey: f.key,
          date,
          users,
          events: users * (3 + rng.int(0, 6)),
          source: "MIXPANEL",
        });
      }
    }
  }
  for (let i = 0; i < daily.length; i += 5000)
    await db.usageDaily.createMany({ data: daily.slice(i, i + 5000) });
  for (let i = 0; i < perUser.length; i += 5000)
    await db.userUsageDaily.createMany({ data: perUser.slice(i, i + 5000) });
  for (let i = 0; i < perFeature.length; i += 5000)
    await db.featureUsageDaily.createMany({ data: perFeature.slice(i, i + 5000) });
  log(
    `  usage: ${daily.length} account-days, ${perUser.length} user-days, ${perFeature.length} feature-days`,
  );
}

// ─── Support (Zendesk) ───────────────────────────────────────────────────────
const SUPPORT = "support@muster-demo.test";

function ticket(
  a: AccountSpec,
  personKey: string,
  id: string,
  o: {
    subject: string;
    body: string;
    openedDaysAgo: number;
    priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
    closedAfterDays?: number;
  },
) {
  const person = a.people.find((p) => p.key === personKey)!;
  const opened = daysAgo(o.openedDaysAgo, -2);
  const reply = new Date(opened.getTime() + 3 * 3_600_000);
  const closed =
    o.closedAfterDays !== undefined ? new Date(opened.getTime() + o.closedAfterDays * DAY) : null;
  return {
    externalId: `zd-${id}`,
    subject: o.subject,
    status: closed ? "CLOSED" : "OPEN",
    priority: o.priority ?? "NORMAL",
    requesterEmail: emailOf(a, person),
    requesterName: person.name,
    openedAt: opened,
    updatedAt: closed ?? reply,
    ...(closed ? { closedAt: closed } : {}),
    messages: [
      {
        externalId: `zd-${id}-1`,
        direction: "INBOUND",
        fromAddress: emailOf(a, person),
        fromName: person.name,
        bodyText: o.body,
        sentAt: opened,
      },
      {
        externalId: `zd-${id}-2`,
        direction: "OUTBOUND",
        fromAddress: SUPPORT,
        toAddresses: [emailOf(a, person)],
        bodyText:
          "Thanks for getting in touch. We're looking into this and will update this ticket.",
        sentAt: reply,
      },
    ],
  };
}

async function seedSupport(it: Record<Provider, IngestTarget>) {
  const b = story("brambleway");
  const tickets = [
    ticket(b, "tess", "bw-1", {
      subject: "Scheduled report arrived empty",
      body: "This morning's scheduled ward report arrived with no rows. Can you check what happened?",
      openedDaysAgo: 23,
      closedAfterDays: 2,
    }),
    ticket(b, "hana", "bw-2", {
      subject: "Dashboards timing out during the morning huddle",
      body: "Our clinical dashboards timed out twice during the 8am huddle today. The team had to fall back to spreadsheets.",
      openedDaysAgo: 17,
      priority: "HIGH",
      closedAfterDays: 4,
    }),
    ticket(b, "hana", "bw-3", {
      subject: "Timeouts again, third time this month",
      body: "This is the third time this month our dashboards have timed out during the morning huddle. Frankly this is unacceptable, and the clinical team is frustrated with having no reliable numbers.",
      openedDaysAgo: 11,
      priority: "HIGH",
    }),
    ticket(b, "gil", "bw-4", {
      subject: "Overnight data sync failed",
      body: "The overnight sync from our patient-flow system failed and today's numbers are missing entirely.",
      openedDaysAgo: 6,
      priority: "URGENT",
    }),
    ticket(b, "gil", "bw-5", {
      subject: "Please escalate: repeated outages",
      body: "We have now raised this complaint several times. Please escalate this to your support manager; we need a plan, not another workaround.",
      openedDaysAgo: 3,
      priority: "HIGH",
    }),
    ticket(story("halvorsen"), "ravi", "hv-1", {
      subject: "Route report missing last week's depots",
      body: "The weekly route report is missing the two depots we added last week.",
      openedDaysAgo: 19,
      closedAfterDays: 3,
    }),
    ticket(story("halvorsen"), "ellen", "hv-2", {
      subject: "Exports failing since the depot change",
      body: "Since we restructured the depots, the nightly export to our finance system has failed every night.",
      openedDaysAgo: 9,
      priority: "HIGH",
    }),
    ticket(story("halvorsen"), "delia", "hv-3", {
      subject: "Depot cost report totals are wrong",
      body: "The depot cost report no longer adds up since the restructure, and finance cannot close the month with it.",
      openedDaysAgo: 4,
      priority: "HIGH",
    }),
    ticket(story("orchid-vale"), "aled", "ov-1", {
      subject: "How do I lock a closed period?",
      body: "Is there a way to lock last month's numbers once the close is signed off?",
      openedDaysAgo: 26,
      priority: "LOW",
      closedAfterDays: 1,
    }),
    ticket(story("saltire"), "freya", "sp-1", {
      subject: "Card on file was declined",
      body: "We got an email that the card for the add-on was declined. Can you resend the invoice link?",
      openedDaysAgo: 3,
    }),
    // Story 12: a ticket from someone who is not a known contact at any account.
    {
      externalId: "zd-unknown-1",
      subject: "Pricing for a team of 40 analysts",
      status: "OPEN",
      priority: "NORMAL",
      requesterEmail: "ops@northbeam-capital.test",
      requesterName: "Northbeam Capital operations",
      openedAt: daysAgo(1, -3),
      messages: [
        {
          externalId: "zd-unknown-1-1",
          direction: "INBOUND",
          fromAddress: "ops@northbeam-capital.test",
          bodyText:
            "Hello, we are a 40-person analyst team and a colleague recommended your product. Could someone tell us how onboarding works for a team our size?",
          sentAt: daysAgo(1, -3),
        },
      ],
    },
  ];
  await ingest(it.ZENDESK, "tickets", tickets);
}

/** Brambleway's two latest tickets and Halvorsen's export ticket were escalated in the help desk (a dated help-desk fact). */
async function markEscalations(ctx: TenantContext) {
  const db = scopedDb(ctx);
  for (const externalId of ["zd-bw-4", "zd-bw-5", "zd-hv-2"]) {
    const ref = await db.externalRef.findFirstOrThrow({
      where: { source: "ZENDESK", objectType: "Ticket", externalId },
    });
    const t = await db.ticket.findUniqueOrThrow({ where: { id: ref.internalId } });
    await db.ticket.update({
      where: { id: t.id },
      data: { isEscalated: true, escalatedAt: new Date(t.openedAt.getTime() + 2 * 3_600_000) },
    });
  }
}

// ─── Mail (Gmail) ────────────────────────────────────────────────────────────
const CHECKINS = [
  [
    "Checking in on the new dashboards",
    "Hi {first}, how is the team getting on with the dashboards you set up last month? Happy to walk anyone through them.",
    "Thanks {csm}, the team uses them every morning now. I'll shout if we need a walkthrough.",
  ],
  [
    "Training session on Thursday",
    "Hi {first}, we're running a training session on scheduled reports this Thursday. Would anyone on your team like to join?",
    "Thanks {csm}, I've forwarded it to two of our analysts.",
  ],
  [
    "Notes from our call",
    "Hi {first}, here are the notes from our call. Let me know if I missed anything.",
    "Looks good, thanks for sending these over.",
  ],
  [
    "New filter options",
    "Hi {first}, we shipped new filter options this week. They should make the regional views quicker to build.",
    "Nice, I'll take a look this week.",
  ],
] as const;

async function seedMail(it: Record<Provider, IngestTarget>) {
  const mail: unknown[] = [];
  const csmOf = (a: AccountSpec) =>
    a.owner === "jonah"
      ? { email: MEMBER_EMAIL.jonah, first: "Jonah" }
      : { email: MEMBER_EMAIL.marcus, first: "Marcus" };
  const add = (
    id: string,
    a: AccountSpec,
    dir: "INBOUND" | "OUTBOUND",
    personEmail: string,
    at: Date,
    subject: string,
    body: string,
    thread: string,
    fromName?: string,
  ) =>
    mail.push({
      externalId: `gm-${id}`,
      threadExternalId: `gm-thread-${thread}`,
      direction: dir,
      fromAddress: dir === "OUTBOUND" ? csmOf(a).email : personEmail,
      fromName,
      toAddresses: [dir === "OUTBOUND" ? personEmail : csmOf(a).email],
      subject,
      bodyText: body,
      sentAt: at,
    });

  for (const a of ALL_ACCOUNTS.filter((x) => x.arrUsd >= 10_000 && x.stage !== "LOST")) {
    const champion = a.people.find((p) => p.roles?.some((r) => r.role === "CHAMPION"))!;
    const span = a.onboardingDay ?? 88;
    for (let d = span - 3, n = 0; d > 2; d -= 13, n++) {
      // Quarry Lane: nothing in either direction for the last six weeks.
      if (a.key === "quarry-lane" && d < 44) break;
      const [subject, out, back] = CHECKINS[(n + a.key.length) % CHECKINS.length]!;
      const first = champion.name.split(" ")[0]!;
      const thread = `${a.key}-${n}`;
      const at = daysAgo(d, -4);
      add(
        `${thread}-out`,
        a,
        "OUTBOUND",
        emailOf(a, champion),
        at,
        subject,
        out.replace("{first}", first),
        thread,
      );
      // Halvorsen: Priyanka went quiet weeks before she left. Brambleway: since the outages the
      // customer only talks to us through support tickets. Corvid: replies are sparse and stopped.
      const replies =
        !(a.key === "halvorsen" && d < 50) &&
        !(a.key === "brambleway" && d < 60) &&
        !(a.key === "corvid" && (n % 2 === 1 || d < 35));
      if (replies)
        add(
          `${thread}-in`,
          a,
          "INBOUND",
          emailOf(a, champion),
          new Date(at.getTime() + 5 * 3_600_000),
          `Re: ${subject}`,
          back.replace("{csm}", csmOf(a).first),
          thread,
          champion.name,
        );
    }
  }
  // Story 1: the bounce when Jonah wrote to Priyanka after she left.
  const h = story("halvorsen");
  const priyanka = emailOf(h, h.people[0]!);
  add(
    "hv-bounce-out",
    h,
    "OUTBOUND",
    priyanka,
    daysAgo(8, -4),
    "Quarterly review prep",
    "Hi Priyanka, could we find 30 minutes next week to prepare the quarterly review?",
    "hv-bounce",
  );
  mail.push({
    externalId: "gm-hv-bounce-in",
    threadExternalId: "gm-thread-hv-bounce",
    direction: "INBOUND",
    fromAddress: "mailer-daemon@halvorsen-freight.test",
    fromName: "Mail Delivery Subsystem",
    toAddresses: [MEMBER_EMAIL.jonah],
    subject: "Undeliverable: Quarterly review prep",
    bodyText: `Delivery has failed to ${priyanka}. The address does not exist or is no longer accepting mail.`,
    sentAt: daysAgo(8, -3.9),
  });
  // Story 4: the champion mentions the Research team.
  const l = story("lindqvist");
  add(
    "lq-research",
    l,
    "INBOUND",
    emailOf(l, l.people[0]!),
    daysAgo(9, -2),
    "Research team access",
    "Hi Marcus, our Research department has started building their own lab dashboards and wants their own workspace area. We're close to our seat limit, so can we talk about adding seats?",
    "lq-research",
    "Sofia Lindqvist",
  );
  // Story 7: a thank-you before the QBR.
  const o = story("orchid-vale");
  add(
    "ov-thanks",
    o,
    "INBOUND",
    emailOf(o, o.people[0]!),
    daysAgo(5, -1),
    "Month-end went smoothly",
    "Hi Jonah, a quick note to say the new close dashboard made this month-end much smoother for the whole finance team. Thank you!",
    "ov-thanks",
    "Imogen Vale",
  );
  // Story 9: the detractor's follow-up.
  const f = story("fenwick");
  add(
    "fw-survey",
    f,
    "INBOUND",
    emailOf(f, f.people[0]!),
    daysAgo(6, -2),
    "Re: Your feedback",
    "Hi Jonah, to expand on my survey answer: the attendance reports take too long to build and my coordinators have gone back to exporting to spreadsheets.",
    "fw-survey",
    "Priscilla Hart",
  );
  await ingest(it.GOOGLE_EMAIL, "mail", mail);
}

// ─── Calendar (Google Calendar) ──────────────────────────────────────────────
async function seedMeetings(it: Record<Provider, IngestTarget>) {
  const o = story("orchid-vale");
  const h = story("halvorsen");
  const l = story("lindqvist");
  const at = (n: number, hourUtc: number) => {
    const d = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + n * DAY);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return d;
  };
  const attendees = (a: AccountSpec, keys: string[], csm: string) => [
    { email: csm, responseStatus: "ACCEPTED" },
    ...keys.map((k) => {
      const p = a.people.find((x) => x.key === k)!;
      return { email: emailOf(a, p), name: p.name, responseStatus: "ACCEPTED" };
    }),
  ];
  await ingest(it.GOOGLE_CALENDAR, "meetings", [
    {
      externalId: "gc-ov-checkin",
      title: "Orchid & Vale quarterly check-in",
      startsAt: at(-35, 15),
      endsAt: at(-35, 16),
      organizerEmail: MEMBER_EMAIL.jonah,
      attendees: attendees(o, ["imogen", "selma"], MEMBER_EMAIL.jonah),
      status: "COMPLETED",
    },
    {
      externalId: "gc-ov-qbr",
      title: "Orchid & Vale QBR",
      startsAt: at(6, 15),
      endsAt: at(6, 16),
      organizerEmail: MEMBER_EMAIL.jonah,
      attendees: attendees(o, ["imogen", "rupert", "selma"], MEMBER_EMAIL.jonah),
      status: "SCHEDULED",
    },
    {
      externalId: "gc-hv-sync",
      title: "Halvorsen Freight sync",
      startsAt: at(3, 16),
      endsAt: at(3, 16.5),
      organizerEmail: MEMBER_EMAIL.jonah,
      attendees: attendees(h, ["oskar", "delia"], MEMBER_EMAIL.jonah),
      status: "SCHEDULED",
    },
    // Older meetings: the last time we met the at-risk and silent accounts.
    ...(
      [
        [
          "gc-hv-qr",
          h,
          "Halvorsen Freight quarterly review",
          -75,
          ["priyanka", "oskar"],
          MEMBER_EMAIL.jonah,
        ],
        [
          "gc-bw-ci",
          story("brambleway"),
          "Brambleway Health check-in",
          -64,
          ["hana"],
          MEMBER_EMAIL.marcus,
        ],
        [
          "gc-cv-ci",
          story("corvid"),
          "Corvid Analytics check-in",
          -82,
          ["mila"],
          MEMBER_EMAIL.jonah,
        ],
        [
          "gc-ql-ci",
          story("quarry-lane"),
          "Quarry Lane Media check-in",
          -70,
          ["dmitri"],
          MEMBER_EMAIL.marcus,
        ],
      ] as const
    ).map(([externalId, a, title, day, keys, csm]) => ({
      externalId,
      title,
      startsAt: at(day, 15),
      endsAt: at(day, 16),
      organizerEmail: csm,
      attendees: attendees(a, [...keys], csm),
      status: "COMPLETED",
    })),
    {
      externalId: "gc-lq-review",
      title: "Lindqvist Robotics usage review",
      startsAt: at(-20, 14),
      endsAt: at(-20, 15),
      organizerEmail: MEMBER_EMAIL.marcus,
      attendees: attendees(l, ["sofia", "arne"], MEMBER_EMAIL.marcus),
      status: "COMPLETED",
    },
  ]);
}

// ─── People-entered records: notes, surveys, onboarding, success plan ────────
async function seedHumanRecords(
  t: Tenancy,
  idOf: Map<string | null, string>,
  contactOf: Map<string, string>,
) {
  const db = scopedDb(t.ctx);
  const ws = t.ctx.workspaceId;
  const acc = (key: string) => idOf.get(story(key).domain)!;
  const contact = (key: string, person: string) => {
    const a = story(key);
    return contactOf.get(
      emailOf(
        a,
        a.people.find((p) => p.key === person)!,
      ).toLowerCase(),
    )!;
  };
  for (const a of ALL_ACCOUNTS.filter((x) => x.pulse)) {
    const pl = a.pulse!;
    await db.csmPulse.create({
      data: {
        workspaceId: ws,
        accountId: idOf.get(a.domain)!,
        membershipId: t.members[pl.by],
        value: pl.value,
        comment: pl.comment,
        createdAt: daysAgo(pl.daysAgo),
        expiresAt: daysFromNow(30 - pl.daysAgo),
      },
    });
  }
  const notes: Array<[string, UserKey, number, string[], string]> = [
    [
      "orchid-vale",
      "jonah",
      35,
      ["meeting", "qbr"],
      "Quarterly check-in with Imogen and Selma. Month-end close is down from five days to three. They want board-ready variance reports next quarter and asked about locking closed periods. Next: QBR in early December with Rupert.",
    ],
    [
      "halvorsen",
      "jonah",
      7,
      ["champion"],
      "Priyanka has left Halvorsen; her email now bounces. Oskar Lund is the exec sponsor; I need a new day-to-day champion before the renewal.",
    ],
    [
      "quarry-lane",
      "marcus",
      20,
      ["renewal"],
      "Two voicemails left for Dmitri about the renewal. No reply yet.",
    ],
    [
      "brambleway",
      "marcus",
      2,
      ["support"],
      "Hana is upset about the huddle timeouts. Engineering is investigating the sync job; I promised an update by Friday.",
    ],
  ];
  for (const [key, by, d, tags, body] of notes)
    await db.note.create({
      data: {
        workspaceId: ws,
        accountId: acc(key),
        authorMembershipId: t.members[by],
        body,
        tags,
        origin: "HUMAN",
        source: "MANUAL",
        createdAt: daysAgo(d),
      },
    });

  // Surveys: an NPS and a CSAT survey, and the customers' answers.
  const nps = await db.survey.create({
    data: {
      workspaceId: ws,
      type: "NPS",
      trigger: "MANUAL",
      question: "How likely are you to recommend Muster to a colleague?",
      status: "ACTIVE",
    },
  });
  const csat = await db.survey.create({
    data: {
      workspaceId: ws,
      type: "CSAT",
      trigger: "TICKET_CLOSED",
      question: "How satisfied were you with the support you received?",
      status: "ACTIVE",
    },
  });
  const responses: Array<[string, string, string, number, number, string]> = [
    [
      nps.id,
      "fenwick",
      "priscilla",
      3,
      7,
      "Reports take far too long to build; my coordinators have gone back to spreadsheets.",
    ],
    [csat.id, "fenwick", "zoe", 2, 4, "The answer did not solve the attendance export problem."],
    [nps.id, "lindqvist", "sofia", 10, 12, "Our plant teams rely on it every shift."],
    [nps.id, "orchid-vale", "imogen", 9, 15, "Month-end is genuinely faster."],
    [nps.id, "saltire", "callum", 8, 20, "Solid, a few rough edges in exports."],
    [csat.id, "orchid-vale", "aled", 5, 25, "Quick and clear answer."],
  ];
  for (const [surveyId, key, person, score, d, comment] of responses)
    await db.surveyResponse.create({
      data: {
        workspaceId: ws,
        surveyId,
        accountId: acc(key),
        contactId: contact(key, person),
        score,
        comment,
        respondedAt: daysAgo(d),
      },
    });

  // Onboarding (story 5): the mid-touch template and Tamsin's plan in its current state.
  const steps = [
    { key: "kickoff", title: "Kickoff call", ownerSide: "US", dueDay: 3, done: true },
    { key: "admin_guide", title: "Send admin guide", ownerSide: "US", dueDay: 7, done: true },
    {
      key: "sso",
      title: "SSO setup",
      ownerSide: "CUSTOMER",
      dueDay: 21,
      done: false,
      customer: "viktor",
    },
    {
      key: "first_dashboard",
      title: "First dashboard built",
      ownerSide: "CUSTOMER",
      dueDay: 21,
      completesWhen: { metric: "featureUsed", featureKey: "dashboards", minDays: 1 },
    },
    {
      key: "connect_data",
      title: "Connect a data source",
      ownerSide: "CUSTOMER",
      dueDay: 35,
      customer: "viktor",
      completesWhen: { metric: "featureUsed", featureKey: "data_connectors", minDays: 1 },
    },
    { key: "training", title: "Team training", ownerSide: "US", dueDay: 38, done: false },
    { key: "review", title: "45-day review", ownerSide: "US", dueDay: 45, done: false },
  ] as const;
  const template = await db.onboardingTemplate.create({
    data: {
      workspaceId: ws,
      name: "Mid-touch standard (60d)",
      forTier: "MID_TOUCH",
      targetDays: 60,
      steps: json(
        steps.map(({ key, title, ownerSide, dueDay, ...r }) => ({
          key,
          title,
          ownerSide,
          dueDay,
          ...("completesWhen" in r ? { completesWhen: r.completesWhen } : {}),
        })),
      ),
      valueDefinition: json([
        { metric: "featureUsed", featureKey: "data_connectors", minDays: 3 },
        { metric: "activeSeatShare", min: 0.4, days: 10 },
      ]),
    },
  });
  const tamsin = story("tamsin");
  const day = tamsin.onboardingDay!;
  const plan = await db.onboardingPlan.create({
    data: {
      workspaceId: ws,
      accountId: acc("tamsin"),
      templateId: template.id,
      startDate: dayKey(day),
      targetValueDate: dayKey(day - 60),
      status: "ACTIVE",
      valueEvidence: json([]),
      blockers: json([]),
      handoff: json({}),
    },
  });
  for (const [i, s] of steps.entries()) {
    const done = "done" in s && s.done;
    await db.onboardingStep.create({
      data: {
        workspaceId: ws,
        planId: plan.id,
        key: s.key,
        position: i + 1,
        title: s.title,
        ownerSide: s.ownerSide,
        ownerMembershipId: s.ownerSide === "US" ? t.members.jonah : null,
        ownerContactId: "customer" in s ? contact("tamsin", s.customer) : null,
        dueDate: dayKey(day - s.dueDay),
        ...("completesWhen" in s ? { completesWhen: json(s.completesWhen) } : {}),
        doneAt: done ? dayKey(day - s.dueDay) : null,
        completedVia: done ? "HUMAN" : null,
        completedByMembershipId: done ? t.members.jonah : null,
        evidence: json([]),
      },
    });
  }
  await db.goal.create({
    data: {
      workspaceId: ws,
      accountId: acc("tamsin"),
      text: "Lab throughput reporting in one place by the end of the quarter",
      sourceType: "Account",
      sourceId: acc("tamsin"),
      quote: "From the deal notes: lab throughput reporting in one place by quarter end",
      origin: "HUMAN",
      status: "OPEN",
    },
  });

  // Story 7: a success plan the customer can see in the portal.
  const sp = await db.successPlan.create({
    data: {
      workspaceId: ws,
      accountId: acc("orchid-vale"),
      title: "FY27 finance transformation",
      sharedWithPortal: true,
    },
  });
  for (const [text, status] of [
    ["Close the books in three days", "ACHIEVED"],
    ["Board-ready variance reports every month", "OPEN"],
    ["Roll out to the Dublin office", "OPEN"],
  ] as const)
    await db.goal.create({
      data: {
        workspaceId: ws,
        accountId: acc("orchid-vale"),
        successPlanId: sp.id,
        text,
        status,
        origin: "HUMAN",
      },
    });

  // Human tasks (one overdue) so Today has a person's own work beside the AI's.
  for (const [key, by, title, due] of [
    ["halvorsen", "jonah", "Find a new champion at Halvorsen", 2],
    ["quarry-lane", "marcus", "Reach Jules Martin about the lapsed renewal", -3],
    ["orchid-vale", "jonah", "Send QBR agenda to Imogen", 3],
  ] as const)
    await db.task.create({
      data: {
        workspaceId: ws,
        accountId: acc(key),
        title,
        ownerMembershipId: t.members[by],
        createdByMembershipId: t.members[by],
        dueAt: due < 0 ? daysAgo(-due) : daysFromNow(due),
        priority: "HIGH",
        status: "OPEN",
        origin: "HUMAN",
        source: "MANUAL",
        createdAt: daysAgo(6),
      },
    });
}

// ─── Pipelines ───────────────────────────────────────────────────────────────
async function nightly(ctx: TenantContext, label: string) {
  const r = await runNightlyInline(ctx, TODAY, clock);
  log(`  nightly (${label}) as of ${TODAY}: ${JSON.stringify(r)}`);
}

async function bandReport(ctx: TenantContext) {
  const db = scopedDb(ctx);
  const rows = await db.account.findMany({
    select: {
      name: true,
      lifecycleStage: true,
      tier: true,
      currentHealth: { select: { overall: true, riskLevel: true } },
    },
    orderBy: { name: "asc" },
  });
  for (const r of rows)
    log(
      `    ${r.name.padEnd(28)} ${r.tier.padEnd(10)} ${r.lifecycleStage.padEnd(11)} ${r.currentHealth ? `${r.currentHealth.riskLevel} ${r.currentHealth.overall === null ? "n/a" : Number(r.currentHealth.overall).toFixed(1)}` : "not scored"}`,
    );
  const signals = await db.signal.groupBy({
    by: ["ruleKey"],
    where: { status: "OPEN" },
    _count: true,
  });
  log(`  open signals: ${signals.map((s) => `${s.ruleKey}=${s._count}`).join(", ")}`);
}

/** The configured provider without the Batch API, so sweep results land now, not within a day. */
function realtimeProvider(): AiProvider {
  const real = getAiProvider();
  return { name: real.name, generateStructured: real.generateStructured.bind(real) };
}

async function drainPlays(ctx: TenantContext) {
  const opts = { connection: redisConnection(), prefix: queuePrefix() };
  const worker = new Worker("plays", processorFor("plays")!, { ...opts, concurrency: 1 });
  const q = getQueue("plays");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const c = await q.getJobCounts("waiting", "active", "prioritized");
    if ((c.waiting ?? 0) + (c.active ?? 0) + (c.prioritized ?? 0) === 0 && i > 2) break;
  }
  await worker.close();
  const runs = await scopedDb(ctx).playRun.count();
  log(`  plays: ${runs} run(s); later steps that wait on an approval or a delay stay queued`);
}

async function processOutbox(ctx: TenantContext, deps: { provider: AiProvider }) {
  // The product's dispatcher claims this workspace's events; the handlers run here in-process.
  const jobs: Array<{ job: string; data: Record<string, unknown> }> = [];
  for (;;) {
    const r = await dispatchOutbox(OUTBOX_ROUTES, {
      workspaceId: ctx.workspaceId,
      enqueue: async (_q, job, data) => void jobs.push({ job, data }),
    });
    if (r.dispatched === 0) break;
  }
  const tally: Record<string, number> = {};
  for (const j of jobs) {
    tally[j.job] = (tally[j.job] ?? 0) + 1;
    if (j.job === "plays.signalOpened")
      await processPlaySignalOpened(j.data as Parameters<typeof processPlaySignalOpened>[0]);
    else if (j.job === "onboarding.stalled" && !SKIP_AI) await onOnboardingStalled(j.data, deps);
    // health.bandChanged (narratives run below for the story accounts only), approval.requested
    // (no Slack in this workspace) and onboarding.valueReached are kept as dispatched history.
  }
  log(
    `  outbox: ${
      Object.entries(tally)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "nothing due"
    }`,
  );
}

async function runAi(t: Tenancy, idOf: Map<string | null, string>) {
  const ctx = t.ctx;
  const db = scopedDb(ctx);
  const provider = realtimeProvider();
  const deps = { provider };
  const results: string[] = [];
  const note = (label: string, r: { kind: string; status?: string }) =>
    results.push(`${label}: ${r.kind === "run" ? r.status : r.kind}`);
  const acc = (key: string) => idOf.get(story(key).domain)!;

  // 1. The Watcher reads the story messages (labels, quotes verified against the text).
  const watched = await db.message.findMany({
    where: {
      direction: "INBOUND",
      accountId: {
        in: ["halvorsen", "brambleway", "lindqvist", "orchid-vale", "fenwick"].map(acc),
      },
      fromAddress: { not: SUPPORT },
      sentAt: { gte: daysAgo(30) },
    },
    select: { id: true },
  });
  for (const m of watched) {
    const s = { sourceType: "MESSAGE" as const, sourceId: m.id, chunkIndex: 0 };
    note(
      `watcher ${m.id.slice(-6)}`,
      await runAgent(
        ctx,
        watcher,
        s,
        { type: "extraction", id: triggerIdFor(s, watcher.prompt.version) },
        deps,
      ),
    );
  }
  await nightly(ctx, "after the Watcher");

  // 2. Check-in drafts (Outreach) on the two at-risk story accounts.
  for (const [key, rule, person] of [
    ["halvorsen", "usage_drop_vs_normal", "oskar"],
    ["brambleway", null, "hana"],
  ] as const) {
    const a = story(key);
    const signal = await db.signal.findFirst({
      where: { accountId: acc(key), status: "OPEN", ...(rule ? { ruleKey: rule } : {}) },
      orderBy: [{ severity: "desc" }, { firstSeenAt: "asc" }],
    });
    const contact = await db.contact.findFirstOrThrow({
      where: {
        accountId: acc(key),
        email: emailOf(
          a,
          a.people.find((p) => p.key === person)!,
        ),
      },
    });
    const owner = (await db.account.findUniqueOrThrow({ where: { id: acc(key) } }))
      .ownerMembershipId!;
    if (!signal) {
      results.push(`outreach ${key}: skipped, no open signal`);
      continue;
    }
    const input = {
      sourceType: "Signal" as const,
      sourceId: signal.id,
      contactId: contact.id,
      requestedByMembershipId: owner,
      nonce: "muster-demo",
    };
    note(
      `outreach ${key} (${signal.ruleKey})`,
      await runAgent(
        ctx,
        outreach,
        input,
        { type: "check-in", id: `Signal:${signal.id}:muster-demo` },
        deps,
      ),
    );
  }

  // 3. The sweeps a worker runs: renewal plans, expansion, onboarding (this workspace only).
  results.push(`renewal sweep: ${JSON.stringify(await sweepRenewalAgents(ctx, deps))}`);
  results.push(`expansion sweep: ${JSON.stringify(await sweepExpansionAgents(ctx, deps))}`);
  // If the sweep's answer was refused (the executor drops quotes it cannot find in the records),
  // the account owner asks once from the app's own "Ask the Expansion Finder" path.
  const lq = acc("lindqvist");
  if (
    !(await db.approval.findFirst({
      where: { accountId: lq, proposedByRun: { agentKey: "expansion-finder" } },
    }))
  ) {
    const opp = await db.expansionOpportunity.findFirst({
      where: { accountId: lq },
      orderBy: { createdAt: "asc" },
    });
    if (opp)
      results.push(
        `expansion ask (Marcus, Lindqvist): ${JSON.stringify(await askExpansionFinder(t.actors.marcus, { opportunityId: opp.id, nonce: "muster-demo-ask" }, deps))}`,
      );
  }
  results.push(`onboarding sweep: ${JSON.stringify(await sweepOnboardingAgents(ctx, deps))}`);

  // 4. Health narratives for the scored story accounts.
  for (const a of ALL_ACCOUNTS.filter((x) => x.storyNo && x.stage !== "LOST")) {
    const snap = await displayedSnapshot(ctx, acc(a.key));
    if (!snap) continue;
    note(
      `health-analyst ${a.key}`,
      await runAgent(
        ctx,
        healthAnalyst,
        { accountId: acc(a.key), snapshotId: snap.id },
        { type: "snapshot", id: snap.id },
        deps,
      ),
    );
  }

  // 5. Story 7: the QBR draft and the pre-call brief for next week's QBR.
  const jonah = t.actors.jonah;
  const q = new Date(Date.parse(`${TODAY}T00:00:00Z`));
  const quarter = `Q${Math.floor(q.getUTCMonth() / 3) + 1} ${q.getUTCFullYear()}`;
  try {
    const doc = await generateQbr(
      { ...ctx, membershipId: jonah.membershipId, canViewRevenue: true },
      { accountId: acc("orchid-vale"), period: quarter, canViewRevenue: true },
      deps,
    );
    results.push(`qbr orchid-vale ${quarter}: document ${doc.id}`);
  } catch (e) {
    results.push(`qbr orchid-vale: FAILED ${e instanceof Error ? e.message : e}`);
  }
  const qbrMeeting = await db.meeting.findFirst({
    where: { accountId: acc("orchid-vale"), status: "SCHEDULED" },
  });
  if (qbrMeeting) {
    try {
      const brief = await prepareBrief(
        { ...ctx, membershipId: jonah.membershipId },
        { meetingId: qbrMeeting.id },
        deps,
      );
      results.push(`pre-call brief: document ${brief.id}`);
    } catch (e) {
      results.push(`pre-call brief: FAILED ${e instanceof Error ? e.message : e}`);
    }
  }

  // 6. The outbox again (play runs on signals the Watcher opened, approval events).
  await processOutbox(ctx, deps);
  await drainPlays(ctx);

  // 7. The Leader Reporter's weekly digest (staff email goes to the log transport).
  try {
    const d = await runWeeklyDigest({ ...ctx, timezone: WORKSPACE.timezone }, clock, {
      executor: deps,
    });
    results.push(`weekly digest: ${JSON.stringify(d)}`);
  } catch (e) {
    results.push(`weekly digest: FAILED ${e instanceof Error ? e.message : e}`);
  }
  for (const r of results) log(`  ${r}`);
}

async function main() {
  await refuseIfExists();
  log(
    SKIP_AI
      ? "AI: skipped (--skip-ai)"
      : `AI: ${getAiProvider().name}, real time, story accounts only`,
  );
  const t = await createTenancy();
  const it = await createIntegrations(t);
  log("raw inputs:");
  const { idOf, contactOf } = await seedCrm(t, it);
  await seedBilling(t, it);
  await seedUsage(t, idOf, contactOf);
  await seedSupport(it);
  await markEscalations(t.ctx);
  await seedMail(it);
  await seedMeetings(it);
  await seedHumanRecords(t, idOf, contactOf);
  const db = scopedDb(t.ctx);
  await recomputeLastTouch(db, t.ctx.workspaceId);
  await syncInbox(t.ctx, { now: NOW });

  log("pipelines:");
  // The weeks before today, as a workspace that was already running would have them: each pass
  // scores and evaluates as of that date (renewals entering their window, the 30-day trend).
  for (const back of [28, 21, 14, 7]) {
    const r = await runNightlyInline(t.ctx, dayStr(back), clock);
    log(`  nightly (history) as of ${dayStr(back)}: ${JSON.stringify(r)}`);
  }
  await nightly(t.ctx, "first pass");
  const champion = await db.play.findFirstOrThrow({ where: { key: "champion-loss" } });
  await publishPlay(t.actors.admin, champion.id);
  log("  published play: Champion Loss");
  await processOutbox(t.ctx, { provider: realtimeProvider() });
  await drainPlays(t.ctx);
  if (!SKIP_AI) await runAi(t, idOf);
  log("result:");
  await bandReport(t.ctx);
  const approvals = await db.approval.findMany({
    select: { status: true, isSensitive: true, kind: true, account: { select: { name: true } } },
  });
  for (const a of approvals)
    log(
      `    approval ${a.kind} ${a.status}${a.isSensitive ? " SENSITIVE" : ""} — ${a.account?.name}`,
    );
  log(
    `logins (demo seed password, see prisma/seed/users.ts): ${USERS.map((u) => `${u.email} (${u.role})`).join(", ")}`,
  );
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues().catch(() => undefined);
    await rawDb.$disconnect();
    process.exit();
  });
