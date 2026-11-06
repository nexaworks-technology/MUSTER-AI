/**
 * Synthetic scale generator (M12 B3; docs/SEED_DATA.md "scale generator"): `pnpm db:seed:scale
 * --accounts 2000 [--workspace scale-test] [--reset]`.
 *
 * SEED TOOLING ONLY (CLAUDE.md Rule 6): every row is synthetic, flagged source SEED, in its OWN
 * workspace ("scale-test" by default). It never touches larkspur-demo, ferngrove-test or
 * juniper-fresh and refuses those slugs. Deterministic: one seeded RNG per account, stable ids,
 * so the same arguments always produce the same rows. Without --reset a workspace that already
 * has accounts is left alone; --reset deletes that workspace's own account tree (accounts cascade
 * to everything beneath them) and regenerates. The audit log is append-only and is never deleted.
 */
import { hashPassword } from "@/lib/auth/password";
import { fieldCipher } from "@/lib/crypto";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { recomputeCommercials } from "@/modules/billing/service";
import { recomputeLastTouch } from "@/modules/accounts/service";
import { getActiveModel } from "@/modules/health/service";
import { syncSignalRules } from "@/modules/signals/service";
import { daysAgo, daysFromNow, dayKey } from "./demo/dates";
import { createRng, type Rng } from "./demo/random";
import { FEATURES } from "./demo/usage";
import { seedPlaysForWorkspace } from "./plays";
import { DEMO_PASSWORD } from "./users";

export const PROTECTED_SLUGS = ["larkspur-demo", "ferngrove-test", "juniper-fresh"] as const;
const BATCH = 5_000;
/** Accounts per billing transaction: small, so one stays inside the default transaction timeout under load. */
const TX_ACCOUNTS = 20;
const USAGE_DAYS = 180;
const USER_DAYS = 30;
const SCALE_SEATS = ["CSM1", "CSM2", "CSM3", "CSM4", "CSM5", "CSM6"] as const;

export interface ScaleResult {
  workspaceId: string;
  slug: string;
  skipped: boolean;
  generationMs: number;
  counts: Record<string, number>;
}

async function insert<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await write(rows.slice(i, i + BATCH));
}

async function ensureWorkspace(slug: string) {
  const workspace = await rawDb.workspace.upsert({
    where: { slug },
    create: {
      id: `scale${slug}`.slice(0, 30),
      name: `Scale test (${slug})`,
      slug,
      timezone: "America/New_York",
      baseCurrency: "USD",
      setupPending: false,
    },
    update: { status: "ACTIVE", setupPending: false },
  });
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const db = scopedDb({ workspaceId: workspace.id });
  const people = [
    { key: "admin", role: "ADMIN", scope: "ALL", revenue: true },
    { key: "leader", role: "CS_LEADER", scope: "ALL", revenue: true },
    ...SCALE_SEATS.map((k) => ({
      key: k.toLowerCase(),
      role: "CSM",
      scope: "OWN",
      revenue: false,
    })),
  ] as const;
  const memberships: string[] = [];
  for (const p of people) {
    const email = `${p.key}@${slug}.test`;
    const user = await rawDb.user.upsert({
      where: { email },
      create: { id: `${workspace.id}-u-${p.key}`, email, name: `Scale ${p.key}`, passwordHash },
      update: {},
    });
    const m = await db.membership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      create: {
        id: `${workspace.id}-m-${p.key}`,
        workspaceId: workspace.id,
        userId: user.id,
        role: p.role as "ADMIN" | "CS_LEADER" | "CSM",
        canViewRevenue: p.revenue,
        bookScope: p.scope as "OWN" | "ALL",
        status: "ACTIVE",
      },
      update: {},
    });
    if (p.role === "CSM") memberships.push(m.id);
  }
  await db.workspaceSettings.upsert({
    where: { workspaceId: workspace.id },
    create: { workspaceId: workspace.id, data: {} },
    update: {},
  });
  await seedPlaysForWorkspace(workspace.id);
  return { workspace, db, csms: memberships };
}

export async function generateScale(opts: {
  accounts: number;
  slug: string;
  reset: boolean;
  /** Test use: every account gets an inbox item, a pending approval, a promise and a task. */
  dense?: boolean;
  log?: (line: string) => void;
}): Promise<ScaleResult> {
  const log = opts.log ?? (() => undefined);
  if ((PROTECTED_SLUGS as readonly string[]).includes(opts.slug))
    throw new Error(`Refusing to generate scale data into protected workspace "${opts.slug}"`);
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true")
    throw new Error("Refusing to seed synthetic data in production");
  const started = Date.now();
  const { workspace, db, csms } = await ensureWorkspace(opts.slug);
  const workspaceId = workspace.id;
  const existing = await db.account.count();
  if (existing > 0 && !opts.reset) {
    return {
      workspaceId,
      slug: opts.slug,
      skipped: true,
      generationMs: Date.now() - started,
      counts: await countRows(db),
    };
  }
  if (existing > 0) {
    log(`reset: deleting ${existing} accounts of ${opts.slug} (cascades to their records)`);
    await db.account.deleteMany({});
  }

  const cipher = fieldCipher();
  const catalog = FEATURES.map((f) => ({ ...f }));
  for (const f of catalog)
    await db.featureCatalog.upsert({
      where: { workspaceId_featureKey: { workspaceId, featureKey: f.key } },
      create: {
        id: `${workspaceId}-f-${f.key}`,
        workspaceId,
        featureKey: f.key,
        label: f.label,
        isKeyFeature: f.isKey,
        includedInPlans: [...f.plans],
      },
      update: {},
    });

  const SUBJECTS = [
    "Dashboard export fails",
    "How do I add a user",
    "Billing question",
    "Report is slow",
    "SSO setup help",
  ];
  const plansByTier = {
    HIGH_TOUCH: "Enterprise",
    MID_TOUCH: "Growth",
    LONG_TAIL: "Starter",
  } as const;
  const w = <T extends Record<string, unknown>>(row: T) => ({ workspaceId, ...row });
  const accountIds: string[] = [];

  // One account at a time, flushed every 100 accounts so memory stays flat.
  const buf = {
    account: [] as unknown[],
    contact: [] as unknown[],
    contract: [] as unknown[],
    subscription: [] as unknown[],
    invoice: [] as unknown[],
    usageDaily: [] as unknown[],
    userUsageDaily: [] as unknown[],
    featureUsageDaily: [] as unknown[],
    conversation: [] as unknown[],
    message: [] as unknown[],
    ticket: [] as unknown[],
    task: [] as unknown[],
    inboxItem: [] as unknown[],
    approval: [] as unknown[],
    promise: [] as unknown[],
  };
  type CM = (a: { data: never; skipDuplicates: boolean }) => Promise<unknown>;
  const flush = async () => {
    const d = db as unknown as Record<string, { createMany: CM }>;
    for (const [model, rows] of Object.entries(buf)) {
      await insert(rows, (data) =>
        d[model]!.createMany({ data: data as never, skipDuplicates: true }),
      );
      rows.length = 0;
    }
  };

  for (let i = 0; i < opts.accounts; i++) {
    const rng: Rng = createRng(1_000_003 * (i + 1));
    const id = `${workspaceId}-a${i}`;
    accountIds.push(id);
    const r = rng.next();
    const tier = r < 0.03 ? "HIGH_TOUCH" : r < 0.2 ? "MID_TOUCH" : "LONG_TAIL";
    const stageRoll = rng.next();
    const stage =
      stageRoll < 0.1
        ? "ONBOARDING"
        : stageRoll < 0.65
          ? "ADOPTING"
          : stageRoll < 0.9
            ? "MATURE"
            : "RENEWING";
    const plan = plansByTier[tier];
    const seats =
      tier === "HIGH_TOUCH"
        ? rng.int(80, 400)
        : tier === "MID_TOUCH"
          ? rng.int(20, 80)
          : rng.int(3, 20);
    const onboardingDay = stage === "ONBOARDING" ? rng.int(5, 55) : undefined;
    const renewalInDays =
      stage === "RENEWING"
        ? rng.int(10, 80)
        : onboardingDay !== undefined
          ? 365 - onboardingDay
          : rng.int(30, 340);
    const monthly = plan === "Starter";
    const value = seats * (monthly ? 600 : 900);
    buf.account.push(
      w({
        id,
        name: `Scale Account ${String(i + 1).padStart(5, "0")}`,
        domain: `acct-${i}.scale.test`,
        tier,
        tierSource: "RULE",
        lifecycleStage: stage,
        onboardingStartedAt: onboardingDay !== undefined ? daysAgo(onboardingDay) : null,
        ownerMembershipId: csms[i % csms.length]!,
        plan,
        industry: rng.pick(["SaaS", "Finance", "Health", "Retail", "Media"]),
        employeeBand: seats > 100 ? "201-1000" : seats > 20 ? "51-200" : "1-50",
        timezone: "America/New_York",
        source: "SEED",
      }),
    );

    const contactCount = rng.int(3, 6);
    const people: { ext: string; contactId: string | null }[] = [];
    for (let c = 0; c < contactCount; c++) {
      const contactId = `${id}-c${c}`;
      buf.contact.push(
        w({
          id: contactId,
          accountId: id,
          name: `Contact ${c} of ${i}`,
          email: `person${c}@acct-${i}.scale.test`,
          title: rng.pick(["Admin", "Analyst", "VP Operations", "Director", "Engineer"]),
          status: "ACTIVE",
          externalUserId: `${id}:c${c}`,
          lastContactAt: daysAgo(rng.int(2, 60)),
          source: "SEED",
        }),
      );
      people.push({ ext: `${id}:c${c}`, contactId });
    }

    // Commercial: a current contract (+ a predecessor for a quarter of accounts), subscription, invoice.
    const startAgo = 365 - renewalInDays;
    const contractId = `${id}-k2`;
    buf.contract.push(
      w({
        id: contractId,
        accountId: id,
        startDate: daysAgo(startAgo),
        endDate: daysFromNow(renewalInDays),
        renewalDate: daysFromNow(renewalInDays),
        autoRenew: tier === "LONG_TAIL",
        noticePeriodDays: rng.pick([30, 60, 90]),
        valueMinor: BigInt(value * 100),
        currency: "USD",
        seatsPurchased: seats,
        termsEnc: cipher.encrypt("Synthetic scale-test terms."),
        status: "ACTIVE",
        source: "SEED",
      }),
    );
    if (rng.chance(0.25) && onboardingDay === undefined)
      buf.contract.push(
        w({
          id: `${id}-k1`,
          accountId: id,
          startDate: daysAgo(startAgo + 365),
          endDate: daysAgo(startAgo),
          renewalDate: daysAgo(startAgo),
          autoRenew: false,
          noticePeriodDays: 30,
          valueMinor: BigInt(Math.round(value * 0.9) * 100),
          currency: "USD",
          seatsPurchased: seats,
          status: "ENDED",
          source: "SEED",
        }),
      );
    buf.subscription.push(
      w({
        id: `${id}-s2`,
        accountId: id,
        contractId,
        plan,
        interval: monthly ? "MONTH" : "YEAR",
        amountMinor: BigInt(Math.round((value * 100) / (monthly ? 12 : 1))),
        currency: "USD",
        quantity: seats,
        status: "ACTIVE",
        currentPeriodEnd: daysFromNow(renewalInDays),
        source: "SEED",
      }),
    );
    const issued = daysAgo(Math.min(startAgo, 30 * rng.int(0, 11)));
    buf.invoice.push(
      w({
        id: `${id}-inv0`,
        accountId: id,
        subscriptionId: `${id}-s2`,
        number: `SCL-${i}-0`,
        amountMinor: BigInt(Math.round((value * 100) / (monthly ? 12 : 1))),
        currency: "USD",
        issuedAt: issued,
        dueAt: new Date(+issued + 30 * 86_400_000),
        paidAt: new Date(+issued + 10 * 86_400_000),
        status: "PAID",
        source: "SEED",
      }),
    );

    // Usage: ~180 daily account rows, a declining tail for 8% of accounts (a realistic mix of signals).
    const base = Math.max(1, Math.round(seats * (0.3 + rng.next() * 0.5)));
    const declining = rng.chance(0.08);
    const from = onboardingDay !== undefined ? onboardingDay : USAGE_DAYS - 1;
    const featureKeys = catalog.filter((f) => (f.plans as readonly string[]).includes(plan));
    for (let d = from; d >= 0; d--) {
      const date = dayKey(d);
      const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 0.25 : 1;
      const decay = declining && d < 35 ? Math.max(0.2, d / 35) : 1;
      const active = Math.min(
        Math.max(base, people.length),
        Math.round(base * decay * weekend * (0.9 + rng.next() * 0.2)),
      );
      buf.usageDaily.push(
        w({
          id: `${id}-ud${d}`,
          accountId: id,
          date,
          activeUsers: active,
          sessions: Math.round(active * (1.3 + rng.next())),
          events: Math.round(active * (18 + rng.next() * 12)),
          seatsUsed: Math.min(seats, Math.round(base * 1.1)),
          source: "SEED",
        }),
      );
      if (d >= USER_DAYS) continue;
      for (const p of people.slice(0, Math.min(active, 6)))
        buf.userUsageDaily.push(
          w({
            id: `${id}-uu${p.ext.split(":c")[1]}-${d}`,
            accountId: id,
            contactId: p.contactId,
            externalUserId: p.ext,
            date,
            events: 5 + rng.int(0, 30),
            sessions: 1 + rng.int(0, 3),
            source: "SEED",
          }),
        );
      for (const f of featureKeys.slice(0, 3)) {
        const users = Math.round(active * f.rate * (0.8 + rng.next() * 0.4));
        if (users > 0)
          buf.featureUsageDaily.push(
            w({
              id: `${id}-fu${f.key}-${d}`,
              accountId: id,
              featureKey: f.key,
              date,
              users,
              events: users * (3 + rng.int(0, 6)),
              source: "SEED",
            }),
          );
      }
    }

    // Conversations and messages (2 threads, 2-5 messages each).
    for (let c = 0; c < 2; c++) {
      const convId = `${id}-cv${c}`;
      const start = rng.int(5, 120);
      const n = rng.int(2, 5);
      buf.conversation.push(
        w({
          id: convId,
          accountId: id,
          channel: "EMAIL",
          subject: `Synthetic thread ${c} for account ${i}`,
          startedAt: daysAgo(start),
          lastMessageAt: daysAgo(Math.max(0, start - n)),
          source: "SEED",
        }),
      );
      for (let m = 0; m < n; m++)
        buf.message.push(
          w({
            id: `${convId}-m${m}`,
            conversationId: convId,
            accountId: id,
            direction: m % 2 === 0 ? "INBOUND" : "OUTBOUND",
            fromContactId: m % 2 === 0 ? people[0]!.contactId : null,
            fromAddress: m % 2 === 0 ? `person0@acct-${i}.scale.test` : `csm@${opts.slug}.test`,
            toAddresses: [m % 2 === 0 ? `csm@${opts.slug}.test` : `person0@acct-${i}.scale.test`],
            sentAt: daysAgo(Math.max(0, start - m)),
            subject: `Synthetic thread ${c} for account ${i}`,
            bodyText: `Synthetic scale-test message ${m} (account ${i}, thread ${c}). No real customer text.`,
            source: "SEED",
          }),
        );
    }
    // Triage, approvals and promises: a share of accounts, so the paginated queues have real depth.
    if (opts.dense || rng.chance(0.5))
      buf.inboxItem.push(
        w({
          id: `${id}-ib0`,
          accountId: id,
          sourceType: "MESSAGE",
          sourceId: `${id}-cv0-m0`,
          status: rng.pick(["NEW", "NEW", "DRAFTED", "REPLIED", "CLOSED"]),
          matchedBy: "CONTACT_EMAIL",
          receivedAt: daysAgo(rng.int(0, 20)),
        }),
      );
    if (opts.dense || rng.chance(0.15))
      buf.approval.push(
        w({
          id: `${id}-ap0`,
          accountId: id,
          kind: "CREATE_TASK",
          payload: {
            changes: [
              {
                kind: "CREATE_TASK",
                accountId: id,
                title: `Synthetic check-in for account ${i}`,
                label: "Create a check-in task",
              },
            ],
          },
          proposedByMembershipId: csms[i % csms.length]!,
          reason: `Synthetic scale-test proposal for account ${i}.`,
          status: "PENDING",
          requiredLevel: "DRAFT_FOR_APPROVAL",
          assigneeId: csms[i % csms.length]!,
          sourceKey: `user:scale:${id}`,
          createdAt: daysAgo(rng.int(0, 14)),
        }),
      );
    if (opts.dense || rng.chance(0.2))
      buf.promise.push(
        w({
          id: `${id}-pr0`,
          accountId: id,
          party: rng.pick(["US", "CUSTOMER"]),
          what: `Synthetic promise for account ${i}`,
          dueDate: rng.chance(0.5) ? daysFromNow(rng.int(-10, 30)) : null,
          ownerMembershipId: csms[i % csms.length]!,
          status: "OPEN",
          statusReason: "Synthetic scale-test promise; no due date has passed.",
          dedupeKey: `scale:${id}:pr0`,
          origin: "HUMAN",
          createdByMembershipId: csms[i % csms.length]!,
        }),
      );
    const tickets = rng.int(0, 5);
    for (let t = 0; t < tickets; t++) {
      const opened = daysAgo(rng.int(1, 150));
      const closed = rng.chance(0.7);
      buf.ticket.push(
        w({
          id: `${id}-t${t}`,
          accountId: id,
          contactId: people[0]!.contactId,
          externalId: `SCL-T-${i}-${t}`,
          subject: rng.pick(SUBJECTS),
          status: closed ? "SOLVED" : "OPEN",
          priority: rng.pick(["LOW", "NORMAL", "NORMAL", "HIGH", "URGENT"]),
          isEscalated: rng.chance(0.03),
          openedAt: opened,
          firstResponseAt: new Date(+opened + rng.int(1, 30) * 3_600_000),
          closedAt: closed ? new Date(+opened + rng.int(1, 6) * 86_400_000) : null,
          source: "SEED",
        }),
      );
    }
    if (opts.dense || rng.chance(0.2))
      for (let t = 0; t < rng.int(1, 2); t++)
        buf.task.push(
          w({
            id: `${id}-tk${t}`,
            accountId: id,
            title: `Synthetic follow-up ${t} for account ${i}`,
            ownerMembershipId: csms[i % csms.length]!,
            dueAt: rng.chance(0.3) ? daysAgo(rng.int(1, 10)) : daysFromNow(rng.int(1, 30)),
            status: "OPEN",
            priority: rng.pick(["LOW", "NORMAL", "HIGH"]),
            origin: "HUMAN",
            source: "SEED",
          }),
        );
    if (buf.account.length >= 100 || i === opts.accounts - 1) {
      await flush();
      if ((i + 1) % 500 === 0 || i === opts.accounts - 1)
        log(`  ${i + 1}/${opts.accounts} accounts written`);
    }
  }

  log("deriving ARR and renewal dates through the billing service ...");
  for (let i = 0; i < accountIds.length; i += TX_ACCOUNTS)
    await db.$tenantTransaction(async (tx) => {
      for (const aid of accountIds.slice(i, i + TX_ACCOUNTS))
        await recomputeCommercials(tx, workspaceId, aid, daysAgo(0));
    });
  await recomputeLastTouch(db, workspaceId);
  await syncSignalRules({ workspaceId });
  await getActiveModel({ workspaceId });
  return {
    workspaceId,
    slug: opts.slug,
    skipped: false,
    generationMs: Date.now() - started,
    counts: await countRows(db),
  };
}

async function countRows(db: ScopedDb): Promise<Record<string, number>> {
  const entries = await Promise.all(
    (
      [
        ["accounts", db.account.count()],
        ["contacts", db.contact.count()],
        ["contracts", db.contract.count()],
        ["subscriptions", db.subscription.count()],
        ["invoices", db.invoice.count()],
        ["usageDaily", db.usageDaily.count()],
        ["userUsageDaily", db.userUsageDaily.count()],
        ["featureUsageDaily", db.featureUsageDaily.count()],
        ["conversations", db.conversation.count()],
        ["messages", db.message.count()],
        ["tickets", db.ticket.count()],
        ["tasks", db.task.count()],
        ["inboxItems", db.inboxItem.count()],
        ["approvals", db.approval.count()],
        ["promises", db.promise.count()],
        ["renewals", db.renewal.count()],
        ["signals", db.signal.count()],
        ["snapshots", db.healthScoreSnapshot.count()],
        ["todayItems", db.todayItem.count()],
      ] as const
    ).map(async ([k, p]) => [k, await p] as const),
  );
  return Object.fromEntries(entries);
}
