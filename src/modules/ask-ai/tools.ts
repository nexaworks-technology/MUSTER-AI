import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { calendarDateOf } from "@/lib/dates";
import { accountListQuery } from "@/modules/accounts/schemas";
import { getAccount, listAccounts, type Actor } from "@/modules/accounts/service";
import { getBilling } from "@/modules/billing/service";
import { searchExtractions } from "@/modules/conversations/service";
import { DocumentError, readDocument } from "@/modules/documents/service";
import { getAccountHealth } from "@/modules/health/service";
import { listPromises } from "@/modules/promises/service";
import { listRenewals } from "@/modules/renewals/service";
import { listAccountSignals, listSignals } from "@/modules/signals/service";
import { listTickets } from "@/modules/support/service";

/**
 * Ask AI's tools (M11 S8, ARCHITECTURE §6.2 row 14). Every tool is a READ built on a module
 * service called with the asking user's Actor, so the workspace scope, role permissions, book
 * scope and money redaction are the same as on that module's own screen (M11 rule 1: Ask AI is
 * not a permission bypass). There is no SQL, write or cross-workspace tool. Each result is a list
 * of citable records — `ref` is `Type:id`, `fields` hold exactly the values an answer may quote —
 * or an explicit `notFound` sentence the answer must repeat instead of guessing (Rule 4).
 */
export type AskActor = Actor;

export type FieldValue = string | number | boolean | null;
export interface AskRecord {
  ref: string;
  type: string;
  id: string;
  label: string;
  href: string | null;
  fields: Record<string, FieldValue>;
}
export interface ToolOutput {
  tool: string;
  records: AskRecord[];
  notFound: string | null;
}
export interface AskTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  run(actor: AskActor, input: z.infer<I>): Promise<Omit<ToolOutput, "tool">>;
}

const MAX_RECORDS = 25;
const id = z.string().trim().min(1).max(64);
const day = (d: Date | null | undefined) => (d ? calendarDateOf(d) : null);
/** Minor units → a plain major-unit string ("123456.00"), so a figure in prose can be checked. */
const major = (minor: bigint | null | undefined): string | null => {
  if (minor === null || minor === undefined) return null;
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
};
const NOT_IN_BOOK = "I cannot see an account with that id in your book.";
const found = (records: AskRecord[], empty: string) => ({
  records: records.slice(0, MAX_RECORDS),
  notFound: records.length ? null : empty,
});
const accountRecord = (
  a: { id: string; name: string },
  fields: Record<string, FieldValue>,
): AskRecord => ({
  ref: `Account:${a.id}`,
  type: "Account",
  id: a.id,
  label: a.name,
  href: `/accounts/${a.id}`,
  fields: { name: a.name, ...fields },
});

const define = <I extends z.ZodTypeAny>(t: AskTool<I>): AskTool => t as unknown as AskTool;

export const ASK_TOOLS: AskTool[] = [
  define({
    name: "searchAccounts",
    description:
      "Find accounts in your book by name or domain (empty query lists them). Returns tier, stage, owner, renewal date, and ARR only for people with revenue access.",
    input: z.object({ query: z.string().trim().max(120).default("") }),
    async run(actor, input) {
      const page = await listAccounts(actor, accountListQuery.parse({ q: input.query }));
      return found(
        page.rows.map((a) =>
          accountRecord(a, {
            domain: a.domain,
            tier: a.tier,
            lifecycleStage: a.lifecycleStage,
            owner: a.ownerName,
            renewalDate: day(a.renewalDate),
            hasContract: a.hasContract,
            ...(a.arr ? { arr: major(a.arr.minor), arrCurrency: a.arr.currency } : {}),
          }),
        ),
        "I cannot see any account matching that in your book.",
      );
    },
  }),
  define({
    name: "getAccount360Summary",
    description:
      "One account's header: tier, stage, owner, plan, last touch, current health band and score.",
    input: z.object({ accountId: id }),
    async run(actor, input) {
      const health = await getAccountHealth(actor, input.accountId);
      if (!health) return { records: [], notFound: NOT_IN_BOOK };
      const a = health.account;
      const s = health.snapshot;
      return found(
        [
          accountRecord(a, {
            tier: a.tier,
            lifecycleStage: a.lifecycleStage,
            owner: a.ownerName,
            plan: a.plan,
            industry: a.industry,
            lastTouch: day(a.lastTouchAt),
            healthBand: s?.riskLevel ?? null,
            healthScore: s?.overall ?? null,
            healthAsOf: s?.asOf ?? null,
            ...(a.arr ? { arr: major(a.arr.minor), arrCurrency: a.arr.currency } : {}),
          }),
        ],
        NOT_IN_BOOK,
      );
    },
  }),
  define({
    name: "listSignals",
    description:
      "Live signals (risks and opportunities) for one account, or across your book when no account is given.",
    input: z.object({ accountId: id.optional() }),
    async run(actor, input) {
      const rows = input.accountId
        ? (await listAccountSignals(actor, input.accountId))?.signals
        : (await listSignals(actor, {})).rows;
      if (!rows) return { records: [], notFound: NOT_IN_BOOK };
      return found(
        rows.map((s) => ({
          ref: `Signal:${s.id}`,
          type: "Signal",
          id: s.id,
          label: s.title,
          href: `/accounts/${s.accountId}/signals`,
          fields: {
            accountId: s.accountId,
            title: s.title,
            explanation: s.explanation,
            severity: s.severity,
            polarity: s.polarity,
            status: s.status,
            firstSeen: day(s.firstSeenAt),
            lastSeen: day(s.lastSeenAt),
          },
        })),
        "There are no signals on record for that.",
      );
    },
  }),
  define({
    name: "searchConversations",
    description:
      "Verbatim quotes extracted from emails, calls and tickets (competitor mentions, budget concerns, promises, complaints…), newest first. Filter by kind, account, text and days back.",
    input: z.object({
      kinds: z
        .array(
          z.enum([
            "SENTIMENT",
            "COMPETITOR",
            "BUDGET_CONCERN",
            "PROMISE",
            "GOAL",
            "CANCEL_LANGUAGE",
            "EXPORT_LANGUAGE",
            "COMPLAINT",
            "RENEWAL_CONCERN",
            "ACTION_ITEM",
            "DECISION",
            "THEME",
            "INTENT",
          ]),
        )
        .max(13)
        .optional(),
      accountId: id.optional(),
      text: z.string().trim().max(120).optional(),
      sinceDays: z.number().int().min(1).max(730).optional(),
    }),
    async run(actor, input) {
      const since = input.sinceDays
        ? new Date(Date.now() - input.sinceDays * 86_400_000)
        : undefined;
      const rows = await searchExtractions(actor, { ...input, since, take: MAX_RECORDS });
      return found(
        rows.map((r) => ({
          ref: `Extraction:${r.id}`,
          type: "Extraction",
          id: r.id,
          label: `${r.label} — ${r.accountName}`,
          href: `/accounts/${r.accountId}/conversations`,
          fields: {
            accountId: r.accountId,
            accountName: r.accountName,
            kind: r.kind,
            label: r.label,
            quote: r.quote,
            sourceType: r.sourceType,
            sourceId: r.sourceId,
            extractedOn: day(r.createdAt),
          },
        })),
        "I cannot see any conversation quote matching that in your book.",
      );
    },
  }),
  define({
    name: "listTickets",
    description:
      "Support tickets for one account: subject, status, priority, escalation, age in days.",
    input: z.object({ accountId: id }),
    async run(actor, input) {
      const account = await getAccount(actor, input.accountId);
      if (!account) return { records: [], notFound: NOT_IN_BOOK };
      const rows = await listTickets(actor, input.accountId);
      return found(
        rows.map((t) => ({
          ref: `Ticket:${t.id}`,
          type: "Ticket",
          id: t.id,
          label: t.subject,
          href: `/accounts/${input.accountId}/tickets`,
          fields: {
            accountId: input.accountId,
            subject: t.subject,
            status: t.status,
            priority: t.priority,
            escalated: t.isEscalated,
            opened: day(t.openedAt),
            closed: day(t.closedAt),
            ageDays: t.ageDays,
          },
        })),
        `There are no support tickets on record for ${account.name}.`,
      );
    },
  }),
  define({
    name: "getContract",
    description:
      "The contracts on file for one account: dates, renewal, notice period, auto-renew, seats; the value only for people with revenue access.",
    input: z.object({ accountId: id }),
    async run(actor, input) {
      const account = await getAccount(actor, input.accountId);
      if (!account) return { records: [], notFound: NOT_IN_BOOK };
      const billing = await getBilling(actor, input.accountId);
      return found(
        billing.contracts.map((c) => ({
          ref: `Contract:${c.id}`,
          type: "Contract",
          id: c.id,
          label: `Contract for ${account.name}`,
          href: `/accounts/${input.accountId}/billing`,
          fields: {
            accountId: input.accountId,
            status: c.status,
            current: c.id === billing.currentContractId,
            start: day(c.startDate),
            end: day(c.endDate),
            renewal: day(c.renewalDate),
            noticePeriodDays: c.noticePeriodDays,
            autoRenew: c.autoRenew,
            seatsPurchased: c.seatsPurchased,
            ...(billing.moneyVisible
              ? { value: major(c.valueMinor ?? null), valueCurrency: c.currency }
              : {}),
          },
        })),
        `I cannot see a contract for ${account.name}.`,
      );
    },
  }),
  define({
    name: "getHealthWithReasons",
    description:
      "One account's current health: score, band, pillar scores and the plain-language reasons with their dates.",
    input: z.object({ accountId: id }),
    async run(actor, input) {
      const h = await getAccountHealth(actor, input.accountId);
      if (!h) return { records: [], notFound: NOT_IN_BOOK };
      const s = h.snapshot;
      if (!s)
        return { records: [], notFound: `There is no health score yet for ${h.account.name}.` };
      return found(
        [
          {
            ref: `HealthScoreSnapshot:${s.id}`,
            type: "HealthScoreSnapshot",
            id: s.id,
            label: `Health of ${h.account.name} on ${s.asOf}`,
            href: `/accounts/${input.accountId}/health`,
            fields: {
              accountId: input.accountId,
              asOf: s.asOf,
              score: s.overall,
              band: s.riskLevel,
              ...Object.fromEntries(Object.entries(s.pillars).map(([k, v]) => [`pillar${k}`, v])),
            },
          },
          ...s.reasons.map((r) => ({
            ref: `HealthReason:${r.id}`,
            type: "HealthReason",
            id: r.id,
            label: r.message,
            href: `/accounts/${input.accountId}/health`,
            fields: {
              snapshotId: s.id,
              pillar: r.pillar,
              direction: r.direction,
              message: r.message,
              periodStart: r.periodStart,
              periodEnd: r.periodEnd,
            },
          })),
        ],
        NOT_IN_BOOK,
      );
    },
  }),
  define({
    name: "listPromises",
    description:
      "Promises made by us or the customer (open by default), with owner, due date and the quote they came from.",
    input: z.object({ accountId: id.optional(), status: z.enum(["OPEN", "ALL"]).default("OPEN") }),
    async run(actor, input) {
      if (input.accountId && !(await getAccount(actor, input.accountId)))
        return { records: [], notFound: NOT_IN_BOOK };
      const { rows } = await listPromises(actor, input);
      return found(
        rows.map((p) => ({
          ref: `Promise:${p.id}`,
          type: "Promise",
          id: p.id,
          label: p.what,
          href: `/accounts/${p.account.id}/promises`,
          fields: {
            accountId: p.account.id,
            accountName: p.account.name,
            what: p.what,
            party: p.party,
            status: p.status,
            due: p.dueDate,
            owner: p.owner?.name ?? null,
            quote: p.quote,
          },
        })),
        "There are no promises on record for that.",
      );
    },
  }),
  define({
    name: "listRenewals",
    description:
      "Open renewals in your book within the next 30/60/90/180/365 days: date, confidence, band, forecast category; ARR at risk only with revenue access.",
    input: z.object({
      days: z
        .union([z.literal(30), z.literal(60), z.literal(90), z.literal(180), z.literal(365)])
        .default(90),
    }),
    async run(actor, input) {
      const page = await listRenewals(actor, { days: input.days });
      return found(
        page.rows.map((r) => ({
          ref: `Renewal:${r.id}`,
          type: "Renewal",
          id: r.id,
          label: `Renewal of ${r.account.name}`,
          href: `/accounts/${r.account.id}/renewal`,
          fields: {
            accountId: r.account.id,
            accountName: r.account.name,
            renewalDate: day(r.renewalDate),
            daysToRenewal: r.daysToRenewal,
            confidence: r.confidence,
            band: r.band,
            category: r.category,
            ...("arrMinor" in r
              ? {
                  arrAtRisk: major(r.arrMinor as bigint | null),
                  arrCurrency: r.currency as string | null,
                }
              : {}),
          },
        })),
        `There are no open renewals in your book in the next ${input.days} days.`,
      );
    },
  }),
  define({
    name: "readDocument",
    description:
      "A generated document (brief, QBR) by id: its locked figures (money only with revenue access) and narrative.",
    input: z.object({ documentId: id }),
    async run(actor, input) {
      let doc;
      try {
        doc = await readDocument(actor, input.documentId);
      } catch (e) {
        if (e instanceof DocumentError)
          return { records: [], notFound: "I cannot see that document." };
        throw e;
      }
      return found(
        [
          {
            ref: `Document:${doc.id}`,
            type: "Document",
            id: doc.id,
            label: doc.title,
            href: `/accounts/${doc.accountId}`,
            fields: {
              accountId: doc.accountId,
              kind: doc.kind,
              title: doc.title,
              text: typeof doc.rendered === "string" ? doc.rendered : JSON.stringify(doc.rendered),
            },
          },
        ],
        "I cannot see that document.",
      );
    },
  }),
];

const BY_NAME = new Map(ASK_TOOLS.map((t) => [t.name, t]));

/** Runs one tool as `actor`: input Zod-parsed; a permission refusal reads as "cannot see". */
export async function runAskTool(actor: AskActor, name: string, raw: unknown): Promise<ToolOutput> {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`unknown tool "${name}"`);
  const input = tool.input.parse(raw);
  try {
    return { tool: name, ...(await tool.run(actor, input)) };
  } catch (e) {
    if (e instanceof ForbiddenError)
      return { tool: name, records: [], notFound: "You do not have access to that." };
    if (e instanceof Error && e.name === "AccountNotFoundError")
      return { tool: name, records: [], notFound: NOT_IN_BOOK };
    throw e;
  }
}
