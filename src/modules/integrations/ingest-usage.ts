import type { Prisma, RecordSource } from "@prisma/client";
import { utcMidnight } from "@/lib/dates";
import type { IngestCounts, IngestProblem } from "./ingest.service";
import type { NormalizedUsageDay } from "./normalized";
import { SOURCE_NAMES } from "./providers";

/**
 * Usage days into UsageDaily / UserUsageDaily / FeatureUsageDaily (M6 B1/B2, D-23). The one path
 * the Usage API's aggregation job, Mixpanel and Amplitude all use.
 *
 * - Accounts are matched, never created. A group id resolves, in order, through an ExternalRef
 *   this source already holds, an account id or CRM id in this workspace, then an account domain;
 *   anything that is not exactly one account is listed as not matched and saved nowhere.
 * - A provider changes only rows it owns or creates. A day another source owns is left as it is
 *   and listed (Q-32 in spirit: never overwrite a different source's number).
 * - SET days replace the day (replaying one changes nothing); ADD days add to it, and are applied
 *   once per batch by the ledger in ingestBatch. A feature's `users` under ADD is the largest
 *   count seen in one batch that day, never a sum: the count is a floor, not an overstatement.
 * - Fixed reads per page: 3 for account matching, 3 for existing rows, 1 for contacts.
 */
type Tx = Prisma.TransactionClient;

export interface UsageRun {
  target: { workspaceId: string; integrationId: string; source: RecordSource };
  tx: Tx;
  counts: IngestCounts;
  accountIds: Set<string>;
  problem(p: IngestProblem): void;
  refs(objectType: string, externalIds: string[]): Promise<Map<string, string>>;
  addRefs(objectType: string, internalType: string, pairs: Array<[string, string]>): Promise<void>;
}

export async function resolveUsageAccounts(
  run: UsageRun,
  groupIds: string[],
): Promise<Map<string, string>> {
  const { tx } = run;
  const wanted = [...new Set(groupIds)];
  const found = await run.refs("Account", wanted);
  const learned: Array<[string, string]> = [];
  const learn = (externalId: string, ids: Iterable<string>) => {
    const unique = [...new Set(ids)];
    if (unique.length === 1 && !found.has(externalId)) {
      found.set(externalId, unique[0]!);
      learned.push([externalId, unique[0]!]);
    }
  };
  let open = wanted.filter((g) => !found.has(g));
  if (open.length) {
    // The customer's group ids are often the CRM's ids for the same company.
    const crm = await tx.externalRef.findMany({
      where: { objectType: "Account", externalId: { in: open } },
      select: { externalId: true, internalId: true },
    });
    for (const g of open)
      learn(
        g,
        crm.filter((r) => r.externalId === g).map((r) => r.internalId),
      );
    open = open.filter((g) => !found.has(g));
  }
  if (open.length) {
    const byId = await tx.account.findMany({
      where: { id: { in: open } },
      select: { id: true },
    });
    for (const a of byId) learn(a.id, [a.id]);
    open = open.filter((g) => !found.has(g));
  }
  if (open.length) {
    const domains = open.map((g) => g.toLowerCase());
    const byDomain = await tx.account.findMany({
      where: { domain: { in: domains, mode: "insensitive" }, archivedAt: null },
      select: { id: true, domain: true },
    });
    for (const g of open)
      learn(
        g,
        byDomain.filter((a) => a.domain?.toLowerCase() === g.toLowerCase()).map((a) => a.id),
      );
  }
  await run.addRefs("Account", "Account", learned);
  for (const g of wanted.filter((x) => !found.has(x)))
    run.problem({
      kind: "UNMATCHED",
      objectType: "Usage",
      externalId: g,
      reason: `Usage for "${g}" matched no single account in this workspace (by account id, CRM id or domain), so it was not saved.`,
    });
  return found;
}

interface Merged {
  accountId: string;
  date: string;
  mode: "SET" | "ADD";
  events: number;
  sessions: number;
  activeUsers?: number;
  users: Map<string, { events: number; sessions: number; email?: string }>;
  features: Map<string, { users: number; events: number }>;
}

function merge(records: NormalizedUsageDay[], accounts: Map<string, string>): Merged[] {
  const out = new Map<string, Merged>();
  for (const r of records) {
    const accountId = accounts.get(r.accountExternalId);
    if (!accountId) continue;
    const key = `${accountId}|${r.date}`;
    let m = out.get(key);
    if (!m || r.mode === "SET") {
      m = {
        accountId,
        date: r.date,
        mode: r.mode,
        events: 0,
        sessions: 0,
        users: new Map(),
        features: new Map(),
      };
      out.set(key, m);
    }
    m.events += r.events;
    m.sessions += r.sessions;
    if (r.activeUsers !== undefined) m.activeUsers = r.activeUsers;
    for (const u of r.users) {
      const had = m.users.get(u.externalUserId);
      m.users.set(u.externalUserId, {
        events: (had?.events ?? 0) + u.events,
        sessions: (had?.sessions ?? 0) + u.sessions,
        email: u.email ?? had?.email,
      });
    }
    for (const f of r.features) {
      const had = m.features.get(f.featureKey);
      m.features.set(f.featureKey, {
        users: Math.max(had?.users ?? 0, f.users),
        events: (had?.events ?? 0) + f.events,
      });
    }
  }
  return [...out.values()];
}

const dayKey = (accountId: string, date: Date | string) =>
  `${accountId}|${typeof date === "string" ? date : date.toISOString().slice(0, 10)}`;

export async function ingestUsage(run: UsageRun, records: NormalizedUsageDay[]) {
  if (records.length === 0) return;
  const { tx, target } = run;
  const accounts = await resolveUsageAccounts(run, [
    ...new Set(records.map((r) => r.accountExternalId)),
  ]);
  const days = merge(records, accounts);
  if (days.length === 0) return;
  const accountIds = [...new Set(days.map((d) => d.accountId))];
  const dates = [...new Set(days.map((d) => d.date))].map(utcMidnight);
  const where = { accountId: { in: accountIds }, date: { in: dates } };
  const emails = [
    ...new Set(
      days.flatMap((d) => [...d.users.entries()].flatMap(([id, u]) => [u.email ?? emailLike(id)])),
    ),
  ].filter((e): e is string => !!e);
  const [existingDays, existingUsers, existingFeatures, contacts] = await Promise.all([
    tx.usageDaily.findMany({ where }),
    tx.userUsageDaily.findMany({ where }),
    tx.featureUsageDaily.findMany({ where }),
    emails.length
      ? tx.contact.findMany({
          where: { accountId: { in: accountIds }, email: { in: emails, mode: "insensitive" } },
          select: { id: true, accountId: true, email: true },
        })
      : Promise.resolve([]),
  ]);
  const dayRow = new Map(existingDays.map((r) => [dayKey(r.accountId, r.date), r]));
  const userRows = new Map<string, Map<string, (typeof existingUsers)[number]>>();
  for (const r of existingUsers) {
    const k = dayKey(r.accountId, r.date);
    (userRows.get(k) ?? userRows.set(k, new Map()).get(k)!).set(r.externalUserId, r);
  }
  const featureRows = new Map<string, Map<string, (typeof existingFeatures)[number]>>();
  for (const r of existingFeatures) {
    const k = dayKey(r.accountId, r.date);
    (featureRows.get(k) ?? featureRows.set(k, new Map()).get(k)!).set(r.featureKey, r);
  }
  const contactId = (accountId: string, email: string | undefined) =>
    email
      ? contacts.find(
          (c) => c.accountId === accountId && c.email?.toLowerCase() === email.toLowerCase(),
        )?.id
      : undefined;

  const createDays: Prisma.UsageDailyCreateManyInput[] = [];
  const createUsers: Prisma.UserUsageDailyCreateManyInput[] = [];
  const createFeatures: Prisma.FeatureUsageDailyCreateManyInput[] = [];
  const updates: Array<() => Promise<unknown>> = [];

  for (const m of days) {
    const key = dayKey(m.accountId, m.date);
    const date = utcMidnight(m.date);
    const base = { workspaceId: target.workspaceId, accountId: m.accountId, date };
    let created = false;
    let changed = false;
    const skipped: string[] = [];
    const owns = (source: RecordSource) => source === target.source;
    const add = m.mode === "ADD";

    // Users
    const haveUsers = userRows.get(key) ?? new Map();
    for (const [externalUserId, u] of m.users) {
      const row = haveUsers.get(externalUserId);
      const linked = contactId(m.accountId, u.email ?? emailLike(externalUserId));
      if (!row) {
        createUsers.push({
          ...base,
          externalUserId,
          events: u.events,
          sessions: u.sessions,
          contactId: linked,
          source: target.source,
        });
        created = true;
      } else if (!owns(row.source)) skipped.push("people");
      else {
        const events = add ? row.events + u.events : u.events;
        const sessions = add ? row.sessions + u.sessions : u.sessions;
        const data = {
          ...(events !== row.events ? { events } : {}),
          ...(sessions !== row.sessions ? { sessions } : {}),
          ...(linked && !row.contactId ? { contactId: linked } : {}),
        };
        if (Object.keys(data).length) {
          updates.push(() => tx.userUsageDaily.update({ where: { id: row.id }, data }));
          changed = true;
        }
      }
    }
    // Features
    const haveFeatures = featureRows.get(key) ?? new Map();
    for (const [featureKey, f] of m.features) {
      const row = haveFeatures.get(featureKey);
      if (!row) {
        createFeatures.push({
          ...base,
          featureKey,
          users: f.users,
          events: f.events,
          source: target.source,
        });
        created = true;
      } else if (!owns(row.source)) skipped.push("features");
      else {
        const events = add ? row.events + f.events : f.events;
        const users = add ? Math.max(row.users, f.users) : f.users;
        if (events !== row.events || users !== row.users) {
          updates.push(() =>
            tx.featureUsageDaily.update({ where: { id: row.id }, data: { events, users } }),
          );
          changed = true;
        }
      }
    }
    // The account's day
    const have = dayRow.get(key);
    const people = new Set([...haveUsers.keys(), ...m.users.keys()]);
    const wantActive = m.activeUsers ?? (m.users.size || add ? people.size : undefined);
    if (!have) {
      createDays.push({
        ...base,
        activeUsers: wantActive ?? 0,
        sessions: m.sessions,
        events: m.events,
        source: target.source,
      });
      created = true;
    } else if (!owns(have.source)) {
      skipped.push("totals");
    } else {
      const events = add ? have.events + m.events : m.events;
      const sessions = add ? have.sessions + m.sessions : m.sessions;
      const activeUsers = wantActive ?? have.activeUsers;
      if (
        events !== have.events ||
        sessions !== have.sessions ||
        activeUsers !== have.activeUsers
      ) {
        updates.push(() =>
          tx.usageDaily.update({ where: { id: have.id }, data: { events, sessions, activeUsers } }),
        );
        changed = true;
      }
    }
    if (skipped.length)
      run.problem({
        kind: "SKIPPED",
        objectType: "Usage",
        reason: `${[...new Set(skipped)].join(", ")} for ${m.date} were left as they are: another source already owns them${have && !owns(have.source) ? ` (${SOURCE_NAMES[have.source] ?? have.source})` : ""}.`,
      });
    if (created) run.counts.created++;
    else if (changed) run.counts.updated++;
    else run.counts.unchanged++;
    run.accountIds.add(m.accountId);
  }
  if (createDays.length) await tx.usageDaily.createMany({ data: createDays, skipDuplicates: true });
  if (createUsers.length)
    await tx.userUsageDaily.createMany({ data: createUsers, skipDuplicates: true });
  if (createFeatures.length)
    await tx.featureUsageDaily.createMany({ data: createFeatures, skipDuplicates: true });
  for (const u of updates) await u();
}

/** A person id that is an email address links to the contact with that address. */
const emailLike = (id: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id) ? id : undefined);
