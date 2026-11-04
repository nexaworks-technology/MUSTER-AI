import { randomBytes } from "node:crypto";
import type { Prisma, RecordSource } from "@prisma/client";
import type { z } from "zod";
import { businessClock } from "@/lib/dates";
import { lockInTransaction } from "@/lib/db/locks";
import { scopedDb } from "@/lib/db/scoped";
import { recomputeCommercials } from "@/modules/billing/service";
import {
  NORMALIZED,
  type NormalizedAccount,
  type NormalizedBatch,
  type NormalizedBillingCustomer,
  type NormalizedContact,
  type NormalizedContract,
  type NormalizedInvoice,
  type NormalizedKind,
  type NormalizedOwner,
  type NormalizedSubscription,
} from "./normalized";
import { ingestUsage } from "./ingest-usage";
import { ingestTickets, ingestMail } from "./ingest-conversations";
import { mergeFields, readFieldSources, type FieldConflict, type FieldValue } from "./provenance";
import { SOURCE_NAMES } from "./providers";

/**
 * The single upsert path from normalized records into accounts, contacts and billing (M5 §2,
 * ARCHITECTURE §8.1). Every external record is mapped through ExternalRef
 * (workspaceId, source, objectType, externalId), so running the same batch twice changes nothing.
 *
 * Each batch runs in one tenant transaction behind a per-integration advisory lock, with a fixed
 * number of reads per batch (no per-record queries for new or unchanged records; acceptance #14).
 * Field conflicts follow Q-32 / D1 (provenance.ts): a differing value from another source becomes
 * a DataQualityIssue (CONFLICT), never an overwrite. Owners are matched by verified member email;
 * an unknown owner leaves the account unassigned and is listed, never guessed. Billing customers
 * are matched to existing accounts and never create one (D-84).
 */
type Tx = Prisma.TransactionClient;

export interface IngestTarget {
  workspaceId: string;
  integrationId: string;
  source: Exclude<RecordSource, "CSV" | "MANUAL" | "SEED" | "SYSTEM">;
}

export interface IngestProblem {
  /** SKIPPED: a record another source owns was left as it is (counted with conflicts). */
  kind: "REJECTED" | "UNMATCHED" | "SKIPPED";
  objectType: string;
  externalId?: string;
  reason: string;
}

export interface IngestCounts {
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  unmatched: number;
  archived: number;
  conflicts: number;
}

export interface IngestResult {
  counts: IngestCounts;
  problems: IngestProblem[];
  /** Accounts whose data changed (for re-evaluation and the sync.completed event). */
  accountIds: string[];
  /** A usage batch whose ledger key was already applied: nothing was read or written. */
  replayed?: boolean;
}

export const emptyCounts = (): IngestCounts => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  rejected: 0,
  unmatched: 0,
  archived: 0,
  conflicts: 0,
});

/** cuid-shaped ids generated here so a whole page of new rows is one INSERT (no N+1). */
const newId = () =>
  `c${BigInt(`0x${randomBytes(16).toString("hex")}`)
    .toString(36)
    .padStart(24, "0")
    .slice(0, 24)}`;

const OBJECT: Record<NormalizedKind, string> = {
  owners: "Owner",
  accounts: "Account",
  customers: "Customer",
  contacts: "Contact",
  subscriptions: "Subscription",
  invoices: "Invoice",
  contracts: "Contract",
  usage: "Usage",
  tickets: "Ticket",
  mail: "Message",
};

const FIELD_LABEL: Record<string, string> = {
  name: "name",
  domain: "domain",
  ownerMembershipId: "account owner",
  industry: "industry",
  employeeBand: "employee band",
  plan: "plan",
  timezone: "time zone",
  email: "email",
  title: "title",
};

class Run {
  readonly counts = emptyCounts();
  readonly problems: IngestProblem[] = [];
  readonly accountIds = new Set<string>();
  constructor(
    readonly target: IngestTarget,
    readonly tx: Tx,
  ) {}

  problem(p: IngestProblem) {
    if (p.kind === "REJECTED") this.counts.rejected++;
    else if (p.kind === "SKIPPED") this.counts.conflicts++;
    else this.counts.unmatched++;
    this.problems.push(p);
  }

  /** ExternalRef lookups for one object type: externalId → internalId. */
  async refs(objectType: string, externalIds: string[]): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map();
    const rows = await this.tx.externalRef.findMany({
      where: {
        source: this.target.source,
        objectType,
        externalId: { in: [...new Set(externalIds)] },
      },
      select: { externalId: true, internalId: true },
    });
    return new Map(rows.map((r) => [r.externalId, r.internalId]));
  }

  async addRefs(objectType: string, internalType: string, pairs: Array<[string, string]>) {
    if (pairs.length === 0) return;
    await this.tx.externalRef.createMany({
      data: pairs.map(([externalId, internalId]) => ({
        workspaceId: this.target.workspaceId,
        integrationId: this.target.integrationId,
        source: this.target.source,
        objectType,
        externalId,
        internalType,
        internalId,
      })),
      skipDuplicates: true,
    });
  }
}

/** Validates each record by itself: a bad record is rejected with a reason, the rest go on. */
function validate<S extends z.ZodType>(
  run: Run,
  kind: NormalizedKind,
  schema: S,
  records: unknown[],
): Array<z.infer<S>> {
  const ok: Array<z.infer<S>> = [];
  for (const raw of records) {
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      ok.push(parsed.data);
      continue;
    }
    const id =
      raw && typeof raw === "object" && "externalId" in raw
        ? String(raw.externalId)
        : raw && typeof raw === "object" && "accountExternalId" in raw
          ? String(raw.accountExternalId)
          : undefined;
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    run.problem({
      kind: "REJECTED",
      objectType: OBJECT[kind],
      externalId: id,
      reason: `${OBJECT[kind]} ${id ?? "(no id)"} ${issue?.message?.startsWith("has ") ? issue.message : `was skipped: ${field || "record"} is not valid`}.`,
    });
  }
  return ok;
}

// ─── Conflicts (Q-32 / D1) ───────────────────────────────────────────────────

interface PendingConflict extends FieldConflict {
  entity: "Account" | "Contact";
  id: string;
  accountId: string;
  label: string;
  display: (v: string) => string;
}

async function crmPrimacy(tx: Tx): Promise<RecordSource[]> {
  const crms = await tx.integration.findMany({
    where: { provider: { in: ["HUBSPOT", "SALESFORCE"] }, status: { not: "DISCONNECTED" } },
    orderBy: { connectedAt: "asc" },
    select: { provider: true },
  });
  return crms.map((c) => c.provider as RecordSource);
}

/** Opens (or refreshes) one CONFLICT issue per field and source; resolves cleared ones. */
async function writeConflicts(run: Run, pending: PendingConflict[], cleared: string[]) {
  const { tx, target } = run;
  const key = (c: { entity: string; id: string; field: string }) =>
    `conflict:${c.entity}:${c.id}:${c.field}:${target.source}`;
  const keys = [...pending.map(key), ...cleared];
  if (keys.length === 0) return;
  const existing = new Map(
    (
      await tx.dataQualityIssue.findMany({
        where: { dedupeKey: { in: keys } },
        select: { id: true, dedupeKey: true, status: true, detail: true },
      })
    ).map((i) => [i.dedupeKey, i]),
  );
  const primacy = await crmPrimacy(tx);
  const me = SOURCE_NAMES[target.source] ?? target.source;
  const create: Prisma.DataQualityIssueCreateManyInput[] = [];
  for (const c of pending) {
    run.counts.conflicts++;
    const theirs = SOURCE_NAMES[c.currentSource as RecordSource] ?? c.currentSource;
    const bothCrm =
      primacy.includes(target.source) && primacy.includes(c.currentSource as RecordSource);
    const primary = bothCrm
      ? ` ${primacy.indexOf(target.source) < primacy.indexOf(c.currentSource as RecordSource) ? me : theirs} was connected first, so the rule prefers its value.`
      : "";
    const detail = `${me} says the ${c.label} is "${c.display(c.incoming)}", but here it is "${c.display(c.current)}" (set by ${theirs}). Nothing was changed.${primary}`;
    const prev = existing.get(key(c));
    if (!prev) {
      create.push({
        workspaceId: target.workspaceId,
        accountId: c.accountId,
        contactId: c.entity === "Contact" ? c.id : null,
        kind: "CONFLICT",
        detail,
        suggestedFix: { type: "NONE" },
        dedupeKey: key(c),
      });
    } else if (prev.status !== "DISMISSED" && (prev.status !== "OPEN" || prev.detail !== detail)) {
      await tx.dataQualityIssue.update({
        where: { id: prev.id },
        data: { detail, status: "OPEN" },
      });
    }
  }
  if (create.length) await tx.dataQualityIssue.createMany({ data: create, skipDuplicates: true });
  const toResolve = cleared
    .map((k) => existing.get(k))
    .filter((i): i is NonNullable<typeof i> => i?.status === "OPEN")
    .map((i) => i.id);
  if (toResolve.length)
    await tx.dataQualityIssue.updateMany({
      where: { id: { in: toResolve } },
      data: { status: "RESOLVED" },
    });
}

// ─── Owners ──────────────────────────────────────────────────────────────────

async function ingestOwners(run: Run, owners: NormalizedOwner[]) {
  const members = await run.tx.membership.findMany({
    where: { status: "ACTIVE", role: { in: ["ADMIN", "CS_LEADER", "CSM"] } },
    select: { id: true, user: { select: { email: true } } },
  });
  const byEmail = new Map(members.map((m) => [m.user.email.toLowerCase(), m.id]));
  const known = await run.refs(
    "Owner",
    owners.map((o) => o.externalId),
  );
  const add: Array<[string, string]> = [];
  for (const o of owners) {
    const member = o.email ? byEmail.get(o.email) : undefined;
    if (!member) {
      run.problem({
        kind: "UNMATCHED",
        objectType: "Owner",
        externalId: o.externalId,
        reason: `Owner ${o.name ?? o.externalId}${o.email ? ` (${o.email})` : ""} is not an active admin, CS leader or CSM here, so their accounts stay unassigned.`,
      });
      continue;
    }
    if (known.get(o.externalId) === member) run.counts.unchanged++;
    else if (known.has(o.externalId)) {
      await run.tx.externalRef.updateMany({
        where: { source: run.target.source, objectType: "Owner", externalId: o.externalId },
        data: { internalId: member },
      });
      run.counts.updated++;
    } else {
      add.push([o.externalId, member]);
      run.counts.created++;
    }
  }
  await run.addRefs("Owner", "Membership", add);
}

// ─── Accounts ────────────────────────────────────────────────────────────────

async function ingestAccounts(run: Run, records: NormalizedAccount[]) {
  const { tx, target } = run;
  const linked = await run.refs(
    "Account",
    records.map((r) => r.externalId),
  );
  const ownerRefs = await run.refs(
    "Owner",
    records.map((r) => r.ownerExternalId).filter((x): x is string => !!x),
  );
  const domains = records
    .filter((r) => !linked.has(r.externalId) && r.domain)
    .map((r) => r.domain!);
  const [current, byDomainRows, members] = await Promise.all([
    tx.account.findMany({ where: { id: { in: [...linked.values()] } } }),
    domains.length
      ? tx.account.findMany({
          where: { domain: { in: domains, mode: "insensitive" } },
          select: { id: true, domain: true },
        })
      : Promise.resolve([]),
    tx.membership.findMany({ select: { id: true, user: { select: { email: true } } } }),
  ]);
  const accounts = new Map(current.map((a) => [a.id, a]));
  const byDomain = new Map<string, string[]>();
  for (const a of byDomainRows) {
    const d = a.domain!.toLowerCase();
    byDomain.set(d, [...(byDomain.get(d) ?? []), a.id]);
  }
  const memberEmail = new Map(members.map((m) => [m.id, m.user.email]));
  // Accounts linked by domain need their full rows too.
  const domainLinked = new Map<string, string>();
  for (const r of records) {
    if (linked.has(r.externalId) || !r.domain) continue;
    const hits = byDomain.get(r.domain) ?? [];
    if (hits.length === 1) domainLinked.set(r.externalId, hits[0]!);
    else if (hits.length > 1)
      run.problem({
        kind: "UNMATCHED",
        objectType: "Account",
        externalId: r.externalId,
        reason: `${r.name}: more than one account here uses the domain ${r.domain}, so it was not linked or created.`,
      });
  }
  if (domainLinked.size) {
    for (const a of await tx.account.findMany({
      where: { id: { in: [...domainLinked.values()] } },
    }))
      accounts.set(a.id, a);
  }

  const creates: Prisma.AccountCreateManyInput[] = [];
  const newRefs: Array<[string, string]> = [];
  const pending: PendingConflict[] = [];
  const cleared: string[] = [];
  const seenInBatch = new Set<string>();
  for (const r of records) {
    if (seenInBatch.has(r.externalId)) continue; // a page can repeat a record; first wins
    seenInBatch.add(r.externalId);
    let ownerMembershipId: string | undefined;
    if (r.ownerExternalId) {
      ownerMembershipId = ownerRefs.get(r.ownerExternalId);
      if (!ownerMembershipId)
        run.problem({
          kind: "UNMATCHED",
          objectType: "Owner",
          externalId: r.ownerExternalId,
          reason: `${r.name}: its owner in ${SOURCE_NAMES[target.source]} is not matched to a member here, so the account owner was left as it is.`,
        });
    }
    const id = linked.get(r.externalId) ?? domainLinked.get(r.externalId);
    if (r.archived) {
      run.counts.archived++;
      if (id && !linked.has(r.externalId)) newRefs.push([r.externalId, id]);
      continue;
    }
    if (!id) {
      if (byDomain.get(r.domain ?? "")?.length) continue; // ambiguous domain, already listed
      const accountId = newId();
      creates.push({
        id: accountId,
        workspaceId: target.workspaceId,
        name: r.name,
        domain: r.domain,
        ownerMembershipId,
        industry: r.industry,
        employeeBand: r.employeeBand,
        plan: r.plan,
        timezone: r.timezone,
        // No ARR on file yet: the tier rule re-tiers it once a contract gives one (D-86).
        tier: "LONG_TAIL",
        tierSource: "RULE",
        source: target.source,
      });
      newRefs.push([r.externalId, accountId]);
      run.accountIds.add(accountId);
      run.counts.created++;
      continue;
    }
    if (!linked.has(r.externalId)) newRefs.push([r.externalId, id]);
    const a = accounts.get(id)!;
    const incoming = {
      name: r.name,
      domain: r.domain,
      ownerMembershipId,
      industry: r.industry,
      employeeBand: r.employeeBand,
      plan: r.plan,
      timezone: r.timezone,
    };
    const merged = mergeFields({
      // Only the incoming string fields are read from the row.
      current: a as unknown as Record<string, FieldValue>,
      fieldSources: readFieldSources(a.fieldSources),
      recordSource: a.source,
      incoming,
      source: target.source,
    });
    for (const c of merged.conflicts)
      pending.push({
        ...c,
        entity: "Account",
        id,
        accountId: id,
        label: FIELD_LABEL[c.field] ?? c.field,
        display:
          c.field === "ownerMembershipId"
            ? (v) => memberEmail.get(v) ?? "an unknown member"
            : (v) => v,
      });
    for (const f of Object.keys(incoming))
      if (!merged.conflicts.some((c) => c.field === f))
        cleared.push(`conflict:Account:${id}:${f}:${target.source}`);
    if (Object.keys(merged.data).length === 0) {
      run.counts.unchanged++;
      continue;
    }
    await tx.account.update({
      where: { id },
      data: { ...merged.data, fieldSources: merged.fieldSources },
    });
    run.accountIds.add(id);
    run.counts.updated++;
  }
  if (creates.length) await tx.account.createMany({ data: creates });
  await run.addRefs("Account", "Account", newRefs);
  await writeConflicts(run, pending, cleared);
}

// ─── Contacts ────────────────────────────────────────────────────────────────

async function ingestContacts(run: Run, records: NormalizedContact[]) {
  const { tx, target } = run;
  const linked = await run.refs(
    "Contact",
    records.map((r) => r.externalId),
  );
  const accountRefs = await run.refs(
    "Account",
    records.map((r) => r.accountExternalId).filter((x): x is string => !!x),
  );
  const emails = records.filter((r) => !linked.has(r.externalId) && r.email).map((r) => r.email!);
  const [current, byEmailRows] = await Promise.all([
    tx.contact.findMany({ where: { id: { in: [...linked.values()] } } }),
    emails.length
      ? tx.contact.findMany({ where: { email: { in: emails, mode: "insensitive" } } })
      : Promise.resolve([]),
  ]);
  const contacts = new Map([...current, ...byEmailRows].map((c) => [c.id, c]));
  const creates: Prisma.ContactCreateManyInput[] = [];
  const newRefs: Array<[string, string]> = [];
  const pending: PendingConflict[] = [];
  const cleared: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.externalId)) continue;
    seen.add(r.externalId);
    if (r.archived) {
      run.counts.archived++;
      continue;
    }
    const accountId = r.accountExternalId ? accountRefs.get(r.accountExternalId) : undefined;
    let id = linked.get(r.externalId);
    if (!id && r.email && accountId) {
      id = byEmailRows.find(
        (c) => c.accountId === accountId && c.email?.toLowerCase() === r.email,
      )?.id;
      if (id) newRefs.push([r.externalId, id]);
    }
    if (!id) {
      if (!accountId) {
        run.problem({
          kind: "UNMATCHED",
          objectType: "Contact",
          externalId: r.externalId,
          reason: `${r.name}: their company is not in this sync, so the contact was not added.`,
        });
        continue;
      }
      const contactId = newId();
      creates.push({
        id: contactId,
        workspaceId: target.workspaceId,
        accountId,
        name: r.name,
        email: r.email,
        title: r.title,
        source: target.source,
      });
      newRefs.push([r.externalId, contactId]);
      run.accountIds.add(accountId);
      run.counts.created++;
      continue;
    }
    const c = contacts.get(id)!;
    const incoming = { name: r.name, email: r.email, title: r.title };
    const merged = mergeFields({
      current: c as unknown as Record<string, FieldValue>,
      fieldSources: readFieldSources(c.fieldSources),
      recordSource: c.source,
      incoming,
      source: target.source,
    });
    for (const k of merged.conflicts)
      pending.push({
        ...k,
        entity: "Contact",
        id,
        accountId: c.accountId,
        label: `contact ${FIELD_LABEL[k.field] ?? k.field}`,
        display: (v) => v,
      });
    for (const f of Object.keys(incoming))
      if (!merged.conflicts.some((k) => k.field === f))
        cleared.push(`conflict:Contact:${id}:${f}:${target.source}`);
    if (Object.keys(merged.data).length === 0) {
      run.counts.unchanged++;
      continue;
    }
    await tx.contact.update({
      where: { id },
      data: { ...merged.data, fieldSources: merged.fieldSources },
    });
    run.accountIds.add(c.accountId);
    run.counts.updated++;
  }
  if (creates.length) await tx.contact.createMany({ data: creates });
  await run.addRefs("Contact", "Contact", newRefs);
  await writeConflicts(run, pending, cleared);
}

// ─── Billing customers (match only, D-84) ────────────────────────────────────

async function ingestCustomers(run: Run, records: NormalizedBillingCustomer[]) {
  const { tx } = run;
  const linked = await run.refs(
    "Customer",
    records.map((r) => r.externalId),
  );
  const open = records.filter((r) => !linked.has(r.externalId) && !r.deleted);
  const domains = [
    ...new Set(
      open.flatMap((r) => [r.domain, r.email?.split("@")[1]]).filter((x): x is string => !!x),
    ),
  ];
  const emails = open.map((r) => r.email).filter((x): x is string => !!x);
  const [accounts, contacts] = await Promise.all([
    domains.length
      ? tx.account.findMany({
          where: { domain: { in: domains, mode: "insensitive" }, archivedAt: null },
          select: { id: true, domain: true },
        })
      : Promise.resolve([]),
    emails.length
      ? tx.contact.findMany({
          where: { email: { in: emails, mode: "insensitive" } },
          select: { accountId: true, email: true },
        })
      : Promise.resolve([]),
  ]);
  const add: Array<[string, string]> = [];
  for (const r of records) {
    if (linked.has(r.externalId)) {
      run.counts.unchanged++;
      continue;
    }
    if (r.deleted) {
      run.counts.archived++;
      continue;
    }
    const tries = [
      r.domain ? accounts.filter((a) => a.domain!.toLowerCase() === r.domain) : [],
      r.email
        ? [
            ...new Set(
              contacts.filter((c) => c.email?.toLowerCase() === r.email).map((c) => c.accountId),
            ),
          ].map((id) => ({ id }))
        : [],
      r.email ? accounts.filter((a) => a.domain!.toLowerCase() === r.email!.split("@")[1]) : [],
    ];
    const hit = tries.find((t) => t.length > 0);
    if (!hit || hit.length > 1) {
      run.problem({
        kind: "UNMATCHED",
        objectType: "Customer",
        externalId: r.externalId,
        reason: `${r.name ?? r.externalId}${r.email ? ` (${r.email})` : ""}: ${hit ? "matches more than one account" : "matches no account by domain or contact email"}, so its billing was not linked.`,
      });
      continue;
    }
    add.push([r.externalId, hit[0]!.id]);
    run.accountIds.add(hit[0]!.id);
    run.counts.created++;
  }
  await run.addRefs("Customer", "Account", add);
}

// ─── Subscriptions, invoices, contracts ──────────────────────────────────────

const same = (a: unknown, b: unknown) =>
  a instanceof Date || b instanceof Date
    ? new Date(a as Date).getTime() === new Date(b as Date).getTime()
    : a === b;

function changed<T extends Record<string, unknown>>(row: Record<string, unknown>, want: T) {
  return Object.fromEntries(
    Object.entries(want).filter(([k, v]) => v !== undefined && !same(row[k] ?? undefined, v)),
  ) as Partial<T>;
}

/** Shared create-or-update for provider-owned rows (billing and CRM deals are not CSV fields). */
async function upsertOwned<R extends { externalId: string }, Row extends { id: string }>(
  run: Run,
  o: {
    objectType: string;
    records: R[];
    accountOf: (r: R) => string | undefined;
    unmatched: (r: R) => string;
    load: (ids: string[]) => Promise<Row[]>;
    fields: (r: R, accountId: string) => Record<string, unknown>;
    createMany: (rows: Array<Record<string, unknown>>) => Promise<unknown>;
    update: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  },
) {
  const linked = await run.refs(
    o.objectType,
    o.records.map((r) => r.externalId),
  );
  const rows = new Map((await o.load([...linked.values()])).map((r) => [r.id, r]));
  const creates: Array<Record<string, unknown>> = [];
  const refs: Array<[string, string]> = [];
  for (const r of o.records) {
    const accountId = o.accountOf(r);
    if (!accountId) {
      run.problem({
        kind: "UNMATCHED",
        objectType: o.objectType,
        externalId: r.externalId,
        reason: o.unmatched(r),
      });
      continue;
    }
    const want = o.fields(r, accountId);
    const id = linked.get(r.externalId);
    const row = id ? rows.get(id) : undefined;
    if (!row) {
      const newRowId = newId();
      creates.push({
        id: newRowId,
        workspaceId: run.target.workspaceId,
        source: run.target.source,
        ...want,
      });
      refs.push([r.externalId, newRowId]);
      run.accountIds.add(accountId);
      run.counts.created++;
      continue;
    }
    const diff = changed(row as unknown as Record<string, unknown>, want);
    if (Object.keys(diff).length === 0) {
      run.counts.unchanged++;
      continue;
    }
    await o.update(row.id, diff);
    run.accountIds.add(accountId);
    run.counts.updated++;
  }
  if (creates.length) await o.createMany(creates);
  await run.addRefs(o.objectType, o.objectType, refs);
}

async function ingestSubscriptions(run: Run, records: NormalizedSubscription[]) {
  const customers = await run.refs(
    "Customer",
    records.map((r) => r.customerExternalId),
  );
  await upsertOwned(run, {
    objectType: "Subscription",
    records,
    accountOf: (r) => customers.get(r.customerExternalId),
    unmatched: (r) =>
      `Subscription ${r.externalId}: its customer ${r.customerExternalId} is not linked to an account, so it was not added.`,
    load: (ids) => run.tx.subscription.findMany({ where: { id: { in: ids } } }),
    fields: (r, accountId) => ({
      accountId,
      plan: r.plan,
      interval: r.interval,
      amountMinor: r.amountMinor,
      currency: r.currency,
      quantity: r.quantity,
      status: r.status,
      currentPeriodEnd: r.currentPeriodEnd,
    }),
    createMany: (rows) =>
      run.tx.subscription.createMany({ data: rows as Prisma.SubscriptionCreateManyInput[] }),
    update: (id, data) => run.tx.subscription.update({ where: { id }, data }),
  });
}

async function ingestInvoices(run: Run, records: NormalizedInvoice[]) {
  const customers = await run.refs(
    "Customer",
    records.map((r) => r.customerExternalId),
  );
  const subs = await run.refs(
    "Subscription",
    records.map((r) => r.subscriptionExternalId).filter((x): x is string => !!x),
  );
  await upsertOwned(run, {
    objectType: "Invoice",
    records,
    accountOf: (r) => customers.get(r.customerExternalId),
    unmatched: (r) =>
      `Invoice ${r.number}: its customer ${r.customerExternalId} is not linked to an account, so it was not added.`,
    load: (ids) => run.tx.invoice.findMany({ where: { id: { in: ids } } }),
    fields: (r, accountId) => ({
      accountId,
      subscriptionId: r.subscriptionExternalId ? subs.get(r.subscriptionExternalId) : undefined,
      number: r.number,
      amountMinor: r.amountMinor,
      currency: r.currency,
      issuedAt: r.issuedAt,
      dueAt: r.dueAt,
      paidAt: r.paidAt,
      status: r.status,
      failureCount: r.failureCount,
      lastFailedAt: r.lastFailedAt,
    }),
    createMany: (rows) =>
      run.tx.invoice.createMany({ data: rows as Prisma.InvoiceCreateManyInput[] }),
    update: (id, data) => run.tx.invoice.update({ where: { id }, data }),
  });
}

async function ingestContracts(run: Run, records: NormalizedContract[]) {
  const accounts = await run.refs(
    "Account",
    records.map((r) => r.accountExternalId),
  );
  const before = new Set(run.accountIds);
  run.accountIds.clear();
  await upsertOwned(run, {
    objectType: "Contract",
    records,
    accountOf: (r) => accounts.get(r.accountExternalId),
    unmatched: (r) =>
      `Contract ${r.externalId}: its company is not in this sync, so it was not added.`,
    load: (ids) => run.tx.contract.findMany({ where: { id: { in: ids } } }),
    fields: (r, accountId) => ({
      accountId,
      startDate: r.startDate,
      endDate: r.endDate,
      renewalDate: r.renewalDate,
      valueMinor: r.valueMinor,
      currency: r.currency,
      status: r.status,
    }),
    createMany: (rows) =>
      run.tx.contract.createMany({ data: rows as Prisma.ContractCreateManyInput[] }),
    update: (id, data) => run.tx.contract.update({ where: { id }, data }),
  });
  // ARR, renewal date and tier derive from contracts (billing service), only where one changed.
  for (const accountId of run.accountIds)
    await recomputeCommercials(run.tx, run.target.workspaceId, accountId, businessClock());
  for (const id of before) run.accountIds.add(id);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const HANDLERS: {
  [K in NormalizedKind]: (
    run: Run,
    records: Array<z.infer<(typeof NORMALIZED)[K]>>,
  ) => Promise<void>;
} = {
  owners: ingestOwners,
  accounts: ingestAccounts,
  customers: ingestCustomers,
  contacts: ingestContacts,
  subscriptions: ingestSubscriptions,
  invoices: ingestInvoices,
  contracts: ingestContracts,
  usage: ingestUsage,
  tickets: ingestTickets,
  mail: ingestMail,
};

/** Upserts one normalized page. Idempotent; never throws for record problems. */
export async function ingestBatch(
  target: IngestTarget,
  batch: NormalizedBatch,
): Promise<IngestResult> {
  return scopedDb(target).$tenantTransaction(async (tx) => {
    await lockInTransaction(tx, `ingest:${target.workspaceId}:${target.integrationId}`);
    const run = new Run(target, tx);
    // A usage batch already applied is skipped whole (M6 B1: replays change nothing).
    if (batch.ledgerKey) {
      const seen = await tx.usageIngestBatch.findUnique({
        where: {
          workspaceId_integrationId_batchKey: {
            workspaceId: target.workspaceId,
            integrationId: target.integrationId,
            batchKey: batch.ledgerKey,
          },
        },
        select: { id: true },
      });
      if (seen) {
        run.counts.unchanged = batch.records.length;
        return { counts: run.counts, problems: [], accountIds: [], replayed: true };
      }
    }
    const records = validate(run, batch.kind, NORMALIZED[batch.kind], batch.records);
    // Each handler takes the records its own schema produced.
    await (HANDLERS[batch.kind] as (run: Run, r: unknown[]) => Promise<void>)(run, records);
    if (batch.ledgerKey)
      await tx.usageIngestBatch.create({
        data: {
          workspaceId: target.workspaceId,
          integrationId: target.integrationId,
          batchKey: batch.ledgerKey,
          events: batch.ledgerEvents ?? batch.records.length,
          unmatched: run.problems
            .filter((p) => p.kind === "UNMATCHED")
            .slice(0, 20)
            .map((p) => ({ groupId: p.externalId ?? null, reason: p.reason })),
          skipped: run.problems
            .filter((p) => p.kind === "SKIPPED")
            .slice(0, 20)
            .map((p) => p.reason),
        },
      });
    return { counts: run.counts, problems: run.problems, accountIds: [...run.accountIds] };
  });
}

export function addCounts(a: IngestCounts, b: IngestCounts): IngestCounts {
  return Object.fromEntries(
    Object.keys(a).map((k) => [k, a[k as keyof IngestCounts] + b[k as keyof IngestCounts]]),
  ) as unknown as IngestCounts;
}
