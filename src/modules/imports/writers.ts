import type { Prisma } from "@prisma/client";
import {
  insertOutsideSignal,
  outsideDedupeKey,
  outsideInputFor,
  syncSignalRules,
} from "@/modules/signals/service";
import type { ScopedDb } from "@/lib/db/scoped";
import { todayIn, businessClock } from "@/lib/dates";
import { loadContext } from "@/modules/health/service";
import type { ValidRecord } from "./parse";
import type { ImportKind } from "./templates";

/**
 * Per-template planning and writing (D-47). `plan` is read-only and decides, for every valid
 * row, CREATE / UPDATE / UNCHANGED / FAIL (with a plain-words reason). The preview shows the
 * plan; the background run re-plans each chunk and applies it inside one tenant transaction.
 * Re-importing the same file therefore plans every row as UNCHANGED.
 */
type Tx = Prisma.TransactionClient;
type Values = Record<string, unknown>;

export interface PlannedRow {
  row: number;
  action: "CREATE" | "UPDATE" | "UNCHANGED" | "FAIL";
  reason?: string;
  apply?: (tx: Tx) => Promise<void>;
  /** Accounts whose derived data (ARR, tier, renewal) must be recomputed after the run. */
  accountId?: string;
}

export interface PlanContext {
  workspaceId: string;
  actorMembershipId: string;
}

const s = (v: unknown) => (v === undefined ? undefined : (v as string));
const same = (a: unknown, b: unknown) =>
  a instanceof Date || b instanceof Date
    ? new Date(a as Date).getTime() === new Date(b as Date).getTime()
    : a === b;
/** Only fields present in the CSV are compared and written; absent optional fields are untouched. */
function changes<T extends Record<string, unknown>>(
  existing: Record<string, unknown>,
  wanted: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(wanted).filter(([k, v]) => v !== undefined && !same(existing[k], v)),
  ) as Partial<T>;
}

async function refs(db: ScopedDb, objectType: string, externalIds: string[]) {
  const rows = externalIds.length
    ? await db.externalRef.findMany({
        where: { source: "CSV", objectType, externalId: { in: externalIds } },
      })
    : [];
  return new Map(rows.map((r) => [r.externalId, r.internalId]));
}

function externalRef(
  ctx: PlanContext,
  objectType: string,
  externalId: string,
  internalId: string,
): Prisma.ExternalRefUncheckedCreateInput {
  return {
    workspaceId: ctx.workspaceId,
    source: "CSV",
    objectType,
    externalId,
    internalType: objectType,
    internalId,
  };
}

/** Resolves account_id (CSV id) or account_domain to an account id, with a reason when it can't. */
async function accountResolver(db: ScopedDb, records: ValidRecord[]) {
  const byRef = await refs(db, "Account", [
    ...new Set(records.map((r) => s(r.values.account_id)).filter((x): x is string => !!x)),
  ]);
  const accounts = await db.account.findMany({
    where: { domain: { not: null } },
    select: { id: true, domain: true },
  });
  const byDomain = new Map<string, string[]>();
  for (const a of accounts)
    byDomain.set(a.domain!.toLowerCase(), [...(byDomain.get(a.domain!.toLowerCase()) ?? []), a.id]);
  return (v: Values, row: number): { id?: string; reason?: string } => {
    if (v.account_id) {
      const id = byRef.get(String(v.account_id));
      return id
        ? { id }
        : {
            reason: `Row ${row}: account_id '${String(v.account_id)}' was not found. Import accounts first, or use account_domain.`,
          };
    }
    const hits = byDomain.get(String(v.account_domain).toLowerCase()) ?? [];
    if (hits.length === 1) return { id: hits[0] };
    if (hits.length > 1)
      return {
        reason: `Row ${row}: more than one account uses the domain '${String(v.account_domain)}'. Use account_id instead.`,
      };
    return { reason: `Row ${row}: no account has the domain '${String(v.account_domain)}'.` };
  };
}

async function memberByEmail(db: ScopedDb) {
  const members = await db.membership.findMany({
    where: { status: "ACTIVE", role: { in: ["ADMIN", "CS_LEADER", "CSM"] } },
    select: { id: true, user: { select: { email: true } } },
  });
  return new Map(members.map((m) => [m.user.email.toLowerCase(), m.id]));
}

async function contactByEmail(db: ScopedDb, emails: string[]) {
  const rows = emails.length
    ? await db.contact.findMany({
        where: { email: { in: emails, mode: "insensitive" } },
        select: { id: true, email: true, accountId: true },
      })
    : [];
  return new Map(rows.map((c) => [c.email!.toLowerCase(), c]));
}

// ─── Writers ─────────────────────────────────────────────────────────────────

async function planAccounts(
  db: ScopedDb,
  ctx: PlanContext,
  records: ValidRecord[],
): Promise<PlannedRow[]> {
  const existingIds = await refs(
    db,
    "Account",
    records.map((r) => String(r.values.account_id)),
  );
  const existing = new Map(
    (await db.account.findMany({ where: { id: { in: [...existingIds.values()] } } })).map((a) => [
      a.id,
      a,
    ]),
  );
  const owners = await memberByEmail(db);
  return records.map(({ row, values: v }): PlannedRow => {
    let ownerMembershipId: string | undefined;
    if (v.owner_email) {
      ownerMembershipId = owners.get(String(v.owner_email));
      if (!ownerMembershipId)
        return {
          row,
          action: "FAIL",
          reason: `Row ${row}: owner_email '${String(v.owner_email)}' is not an active admin, CS leader or CSM here.`,
        };
    }
    const wanted = {
      name: s(v.name),
      domain: s(v.domain),
      tier: s(v.tier) as Prisma.AccountUncheckedCreateInput["tier"] | undefined,
      lifecycleStage: s(v.stage) as
        Prisma.AccountUncheckedCreateInput["lifecycleStage"] | undefined,
      ownerMembershipId,
      plan: s(v.plan),
      industry: s(v.industry),
      employeeBand: s(v.employee_band),
      onboardingStartedAt: v.onboarding_started as Date | undefined,
    };
    const id = existingIds.get(String(v.account_id));
    const current = id ? existing.get(id) : undefined;
    if (!current) {
      return {
        row,
        action: "CREATE",
        apply: async (tx) => {
          const created = await tx.account.create({
            data: {
              workspaceId: ctx.workspaceId,
              source: "CSV",
              tierSource: "RULE",
              ...wanted,
              name: wanted.name!,
              tier: wanted.tier!,
            },
          });
          await tx.externalRef.create({
            data: externalRef(ctx, "Account", String(v.account_id), created.id),
          });
        },
      };
    }
    const diff = changes(current, wanted);
    if (Object.keys(diff).length === 0) return { row, action: "UNCHANGED" };
    return {
      row,
      action: "UPDATE",
      apply: async (tx) =>
        void (await tx.account.update({ where: { id: current.id }, data: diff })),
    };
  });
}

async function planContacts(
  db: ScopedDb,
  ctx: PlanContext,
  records: ValidRecord[],
): Promise<PlannedRow[]> {
  const resolve = await accountResolver(db, records);
  const keyOf = (v: Values) => (v.contact_id ? String(v.contact_id) : `email:${String(v.email)}`);
  const byRef = await refs(
    db,
    "Contact",
    records.map((r) => keyOf(r.values)),
  );
  const byEmail = await contactByEmail(
    db,
    records.map((r) => String(r.values.email)),
  );
  const existing = new Map(
    (
      await db.contact.findMany({
        where: { id: { in: [...byRef.values(), ...[...byEmail.values()].map((c) => c.id)] } },
        include: { roles: { where: { validTo: null } } },
      })
    ).map((c) => [c.id, c]),
  );
  return records.map(({ row, values: v }): PlannedRow => {
    const acct = resolve(v, row);
    if (!acct.id) return { row, action: "FAIL", reason: acct.reason };
    const key = keyOf(v);
    const id = byRef.get(key) ?? (v.contact_id ? undefined : byEmail.get(String(v.email))?.id);
    const current = id ? existing.get(id) : undefined;
    const wanted = {
      accountId: acct.id,
      email: s(v.email),
      name: s(v.name),
      title: s(v.title),
      status: s(v.status) as "ACTIVE" | undefined,
      // Explicit only; otherwise the database stamps a real status change (D-56).
      statusChangedAt: v.status_changed_at as Date | undefined,
    };
    const role = s(v.role) as Prisma.StakeholderRoleUncheckedCreateInput["role"] | undefined;
    const addRole = async (tx: Tx, contactId: string) => {
      if (role)
        await tx.stakeholderRole.create({
          data: {
            workspaceId: ctx.workspaceId,
            accountId: acct.id!,
            contactId,
            role,
            validFrom: businessClock(), // business date: the role starts "today" (D-81)
            setByMembershipId: ctx.actorMembershipId,
            origin: "IMPORT",
          },
        });
    };
    if (!current) {
      return {
        row,
        action: "CREATE",
        apply: async (tx) => {
          const created = await tx.contact.create({
            data: {
              workspaceId: ctx.workspaceId,
              source: "CSV",
              ...wanted,
              accountId: acct.id!,
              name: wanted.name!,
            },
          });
          await tx.externalRef.create({ data: externalRef(ctx, "Contact", key, created.id) });
          await addRole(tx, created.id);
        },
      };
    }
    const diff = changes(current, wanted);
    const needsRole = role !== undefined && !current.roles.some((r) => r.role === role);
    const needsRef = !byRef.has(key);
    if (Object.keys(diff).length === 0 && !needsRole && !needsRef)
      return { row, action: "UNCHANGED" };
    return {
      row,
      action: "UPDATE",
      apply: async (tx) => {
        if (Object.keys(diff).length)
          await tx.contact.update({ where: { id: current.id }, data: diff });
        if (needsRef)
          await tx.externalRef.create({ data: externalRef(ctx, "Contact", key, current.id) });
        if (needsRole) await addRole(tx, current.id);
      },
    };
  });
}

async function planById<T extends { id: string } & Record<string, unknown>>(
  db: ScopedDb,
  ctx: PlanContext,
  records: ValidRecord[],
  o: {
    objectType: string;
    keyField: string;
    needsAccount: boolean;
    load: (ids: string[]) => Promise<T[]>;
    data: (
      v: Values,
      accountId: string | undefined,
      row: number,
    ) =>
      | Promise<Record<string, unknown> | { fail: string }>
      | Record<string, unknown>
      | { fail: string };
    create: (tx: Tx, data: Record<string, unknown>) => Promise<{ id: string }>;
    update: (tx: Tx, id: string, data: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<PlannedRow[]> {
  const resolve = o.needsAccount ? await accountResolver(db, records) : null;
  const byRef = await refs(
    db,
    o.objectType,
    records.map((r) => String(r.values[o.keyField])),
  );
  const existing = new Map((await o.load([...byRef.values()])).map((x) => [x.id, x]));
  const out: PlannedRow[] = [];
  for (const { row, values: v } of records) {
    const acct = resolve ? resolve(v, row) : { id: undefined };
    if (resolve && !acct.id) {
      out.push({ row, action: "FAIL", reason: acct.reason });
      continue;
    }
    const data = await o.data(v, acct.id, row);
    if ("fail" in data) {
      out.push({ row, action: "FAIL", reason: data.fail as string });
      continue;
    }
    const key = String(v[o.keyField]);
    const id = byRef.get(key);
    const current = id ? existing.get(id) : undefined;
    if (!current) {
      out.push({
        row,
        action: "CREATE",
        accountId: acct.id,
        apply: async (tx) => {
          const created = await o.create(tx, {
            workspaceId: ctx.workspaceId,
            source: "CSV",
            ...data,
          });
          await tx.externalRef.create({ data: externalRef(ctx, o.objectType, key, created.id) });
        },
      });
      continue;
    }
    const diff = changes(current, data);
    out.push(
      Object.keys(diff).length === 0
        ? { row, action: "UNCHANGED" }
        : {
            row,
            action: "UPDATE",
            accountId: acct.id,
            apply: async (tx) => void (await o.update(tx, current.id, diff)),
          },
    );
  }
  return out;
}

async function planUsage(
  db: ScopedDb,
  ctx: PlanContext,
  kind: "USAGE_ACCOUNT_DAILY" | "USAGE_USER_DAILY" | "USAGE_FEATURE_DAILY",
  records: ValidRecord[],
): Promise<PlannedRow[]> {
  const resolve = await accountResolver(db, records);
  const resolved = records.map((r) => ({ ...r, acct: resolve(r.values, r.row) }));
  const accountIds = [...new Set(resolved.map((r) => r.acct.id).filter((x): x is string => !!x))];
  const dates = [...new Set(records.map((r) => (r.values.date as Date).toISOString()))].map(
    (d) => new Date(d),
  );
  const contacts =
    kind === "USAGE_USER_DAILY"
      ? await contactByEmail(
          db,
          records.map((r) => s(r.values.contact_email)).filter((x): x is string => !!x),
        )
      : new Map();
  const key = (accountId: string, v: Values) =>
    `${accountId}|${(v.date as Date).toISOString().slice(0, 10)}|${String(v.user_id ?? v.feature_key ?? "")}`;
  const existing = new Map<string, Record<string, unknown> & { id: string }>();
  if (accountIds.length) {
    const where = { accountId: { in: accountIds }, date: { in: dates } };
    const rows =
      kind === "USAGE_ACCOUNT_DAILY"
        ? (await db.usageDaily.findMany({ where })).map((r) => [key(r.accountId, r), r] as const)
        : kind === "USAGE_USER_DAILY"
          ? (await db.userUsageDaily.findMany({ where })).map(
              (r) => [key(r.accountId, { date: r.date, user_id: r.externalUserId }), r] as const,
            )
          : (await db.featureUsageDaily.findMany({ where })).map(
              (r) => [key(r.accountId, { date: r.date, feature_key: r.featureKey }), r] as const,
            );
    for (const [k, r] of rows)
      existing.set(k, r as unknown as Record<string, unknown> & { id: string });
  }
  return resolved.map(({ row, values: v, acct }): PlannedRow => {
    if (!acct.id) return { row, action: "FAIL", reason: acct.reason };
    const accountId = acct.id;
    const base = { accountId, date: v.date as Date };
    const wanted =
      kind === "USAGE_ACCOUNT_DAILY"
        ? {
            activeUsers: v.active_users as number,
            sessions: (v.sessions as number | undefined) ?? 0,
            events: (v.events as number | undefined) ?? 0,
            seatsUsed: v.seats_used as number | undefined,
          }
        : kind === "USAGE_USER_DAILY"
          ? {
              externalUserId: String(v.user_id),
              events: v.events as number,
              sessions: (v.sessions as number | undefined) ?? 0,
              contactId: v.contact_email ? contacts.get(String(v.contact_email))?.id : undefined,
            }
          : {
              featureKey: String(v.feature_key),
              users: v.users as number,
              events: (v.events as number | undefined) ?? 0,
            };
    const current = existing.get(key(accountId, v));
    if (current) {
      const diff = changes(current, wanted);
      if (Object.keys(diff).length === 0) return { row, action: "UNCHANGED" };
      return {
        row,
        action: "UPDATE",
        apply: async (tx) => {
          if (kind === "USAGE_ACCOUNT_DAILY")
            await tx.usageDaily.update({ where: { id: current.id }, data: diff });
          else if (kind === "USAGE_USER_DAILY")
            await tx.userUsageDaily.update({ where: { id: current.id }, data: diff });
          else await tx.featureUsageDaily.update({ where: { id: current.id }, data: diff });
        },
      };
    }
    const data = { workspaceId: ctx.workspaceId, source: "CSV" as const, ...base, ...wanted };
    return {
      row,
      action: "CREATE",
      apply: async (tx) => {
        if (kind === "USAGE_ACCOUNT_DAILY")
          await tx.usageDaily.create({ data: data as Prisma.UsageDailyUncheckedCreateInput });
        else if (kind === "USAGE_USER_DAILY")
          await tx.userUsageDaily.create({
            data: data as Prisma.UserUsageDailyUncheckedCreateInput,
          });
        else
          await tx.featureUsageDaily.create({
            data: data as Prisma.FeatureUsageDailyUncheckedCreateInput,
          });
      },
    };
  });
}

export async function planRecords(
  db: ScopedDb,
  ctx: PlanContext,
  kind: ImportKind,
  records: ValidRecord[],
): Promise<PlannedRow[]> {
  switch (kind) {
    case "ACCOUNTS":
      return planAccounts(db, ctx, records);
    case "CONTACTS":
      return planContacts(db, ctx, records);
    case "CONTRACTS":
      return planById(db, ctx, records, {
        objectType: "Contract",
        keyField: "contract_id",
        needsAccount: true,
        load: (ids) => db.contract.findMany({ where: { id: { in: ids } } }),
        data: (v, accountId) => ({
          accountId,
          startDate: v.start_date,
          endDate: v.end_date,
          renewalDate: v.renewal_date,
          valueMinor: v.value,
          currency: v.currency,
          seatsPurchased: v.seats,
          noticePeriodDays: v.notice_days,
          autoRenew: v.auto_renew,
          status: v.status,
        }),
        create: (tx, data) =>
          tx.contract.create({ data: data as Prisma.ContractUncheckedCreateInput }),
        update: (tx, id, data) => tx.contract.update({ where: { id }, data }),
      });
    case "INVOICES":
      return planById(db, ctx, records, {
        objectType: "Invoice",
        keyField: "invoice_number",
        needsAccount: true,
        load: (ids) => db.invoice.findMany({ where: { id: { in: ids } } }),
        data: (v, accountId) => ({
          accountId,
          number: v.invoice_number,
          amountMinor: v.amount,
          currency: v.currency,
          issuedAt: v.issued_date,
          dueAt: v.due_date,
          paidAt: v.paid_date,
          status: v.status ?? (v.paid_date ? "PAID" : "OPEN"),
        }),
        create: (tx, data) =>
          tx.invoice.create({ data: data as Prisma.InvoiceUncheckedCreateInput }),
        update: (tx, id, data) => tx.invoice.update({ where: { id }, data }),
      });
    case "TICKETS": {
      const contacts = await contactByEmail(
        db,
        records.map((r) => s(r.values.contact_email)).filter((x): x is string => !!x),
      );
      return planById(db, ctx, records, {
        objectType: "Ticket",
        keyField: "ticket_id",
        needsAccount: true,
        load: (ids) => db.ticket.findMany({ where: { id: { in: ids } } }),
        data: (v, accountId) => ({
          accountId,
          externalId: v.ticket_id,
          subject: v.subject,
          openedAt: v.opened_at,
          closedAt: v.closed_at,
          status: v.status,
          priority: v.priority,
          isEscalated: v.escalated,
          escalatedAt: v.escalated_at,
          contactId: v.contact_email ? contacts.get(String(v.contact_email))?.id : undefined,
        }),
        create: async (tx, data) => {
          const conversation = await tx.conversation.create({
            data: {
              workspaceId: ctx.workspaceId,
              accountId: data.accountId as string,
              channel: "TICKET",
              subject: data.subject as string,
              startedAt: data.openedAt as Date,
              lastMessageAt: data.openedAt as Date,
              source: "CSV",
            },
          });
          return tx.ticket.create({
            data: {
              ...(data as Prisma.TicketUncheckedCreateInput),
              conversationId: conversation.id,
            },
          });
        },
        update: (tx, id, data) => tx.ticket.update({ where: { id }, data }),
      });
    }
    case "TICKET_MESSAGES": {
      const tickets = await refs(
        db,
        "Ticket",
        records.map((r) => String(r.values.ticket_id)),
      );
      const ticketRows = new Map(
        (await db.ticket.findMany({ where: { id: { in: [...tickets.values()] } } })).map((t) => [
          t.id,
          t,
        ]),
      );
      const contacts = await contactByEmail(
        db,
        records.map((r) => s(r.values.from_email)).filter((x): x is string => !!x),
      );
      return planById(db, ctx, records, {
        objectType: "Message",
        keyField: "message_id",
        needsAccount: false,
        load: (ids) => db.message.findMany({ where: { id: { in: ids } } }),
        data: (v, _a, row) => {
          const ticket = ticketRows.get(tickets.get(String(v.ticket_id)) ?? "");
          if (!ticket?.conversationId)
            return {
              fail: `Row ${row}: ticket '${String(v.ticket_id)}' was not found. Import tickets first.`,
            };
          const from = v.from_email ? contacts.get(String(v.from_email)) : undefined;
          return {
            accountId: ticket.accountId,
            conversationId: ticket.conversationId,
            direction: v.direction,
            sentAt: v.sent_at,
            bodyText: v.body,
            fromAddress: v.from_email,
            fromContactId:
              v.direction === "INBOUND" && from?.accountId === ticket.accountId
                ? from.id
                : undefined,
          };
        },
        create: (tx, data) =>
          tx.message.create({ data: data as Prisma.MessageUncheckedCreateInput }),
        update: (tx, id, data) => tx.message.update({ where: { id }, data }),
      });
    }
    case "OUTSIDE_SIGNALS":
      return planOutside(db, ctx, records);
    default:
      return planUsage(db, ctx, kind, records);
  }
}

/**
 * Outside signals (M3, INTERP-6): validated like the manual form (public link + date, not in the
 * future); a row whose source and date are already recorded is unchanged on re-import.
 */
async function planOutside(
  db: ScopedDb,
  ctx: PlanContext,
  records: ValidRecord[],
): Promise<PlannedRow[]> {
  const resolve = await accountResolver(db, records);
  // The workspace's own date (D-50, M3 rule 7): an event dated today there is not "in the future".
  const today = todayIn((await loadContext(ctx)).timeZone);
  const schema = outsideInputFor(today);
  await syncSignalRules(ctx);
  const rule = await db.signalRule.findFirstOrThrow({ where: { ruleKey: "outside_event" } });
  const parsed = records.map(({ row, values: v }) => {
    const acct = resolve(v, row);
    if (!acct.id) return { row, fail: acct.reason };
    const r = schema.safeParse({
      accountId: acct.id,
      kind: v.kind,
      headline: v.headline,
      sourceUrl: v.source_url ?? "",
      eventDate:
        v.event_date instanceof Date
          ? v.event_date.toISOString().slice(0, 10)
          : (v.event_date ?? ""),
    });
    if (!r.success)
      return {
        row,
        fail: `Row ${row}: ${r.error.issues[0]?.path[0] === "sourceUrl" ? "source_url" : String(r.error.issues[0]?.path[0] ?? "")}: ${r.error.issues[0]?.message}`,
      };
    return { row, input: r.data };
  });
  const keys = parsed.flatMap((p) => ("input" in p && p.input ? [outsideDedupeKey(p.input)] : []));
  const known = new Set(
    (
      await db.signal.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } })
    ).map((s) => s.dedupeKey),
  );
  return parsed.map((p): PlannedRow => {
    if (!("input" in p) || !p.input) return { row: p.row, action: "FAIL", reason: p.fail };
    const input = p.input;
    if (known.has(outsideDedupeKey(input))) return { row: p.row, action: "UNCHANGED" };
    known.add(outsideDedupeKey(input));
    return {
      row: p.row,
      action: "CREATE",
      apply: async (tx) => {
        await insertOutsideSignal(tx, ctx.workspaceId, input, {
          origin: "IMPORT",
          createdByMembershipId: ctx.actorMembershipId,
          today,
          now: businessClock(),
          ruleVersion: rule.version,
        });
      },
    };
  });
}
