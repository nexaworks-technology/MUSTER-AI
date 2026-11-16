import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedBatch, NormalizedEvent } from "../../normalized";
import {
  ProviderHttpError,
  ProviderShapeError,
  requestJson,
  type HttpTransport,
} from "../../transport";

/**
 * Chargebee (API key + site; a read-only key is recommended). Read-only: customers are matched
 * to accounts (D-84), subscriptions and invoices land through ingest. Pages follow `next_offset`;
 * INCREMENTAL adds `updated_at[after]` from the last good run's cursor (unix seconds).
 *
 * Webhooks (D3): Chargebee does not sign webhooks; it sends HTTP Basic credentials that the Admin
 * set on the webhook. Each integration stores its own "user:password" sealed, and verification is
 * a constant-time comparison of the Authorization header with it. Events: payment_failed,
 * payment_succeeded.
 */
const PAGE = "100";
type Cfg = Record<string, never>;

const listOf = <T extends z.ZodType>(key: string, item: T) =>
  z.object({
    list: z.array(z.object({ [key]: item })),
    /**
     * The live site returns the cursor as a JSON array of two strings (["1794861324000","2753"]);
     * older answers (and the recorded fixtures) carry it as a string. Chargebee takes either back as
     * the same text, so both are read and kept as text (see `offsetText`).
     */
    next_offset: z.union([z.string(), z.array(z.string())]).nullish(),
  });

const customer = z.object({
  id: z.string(),
  email: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  deleted: z.boolean().optional(),
});
const subscription = z.object({
  id: z.string(),
  customer_id: z.string(),
  status: z.string(),
  billing_period_unit: z.string().optional(),
  currency_code: z.string(),
  current_term_end: z.number().int().optional(),
  subscription_items: z
    .array(
      z.object({
        item_price_id: z.string(),
        quantity: z.number().int().optional(),
        amount: z.number().int().optional(),
      }),
    )
    .default([]),
  deleted: z.boolean().optional(),
});
const invoice = z.object({
  id: z.string(),
  customer_id: z.string(),
  subscription_id: z.string().nullable().optional(),
  status: z.string(),
  total: z.number().int(),
  currency_code: z.string(),
  date: z.number().int(),
  due_date: z.number().int().nullable().optional(),
  paid_at: z.number().int().nullable().optional(),
  dunning_attempts: z
    .array(z.object({ created_at: z.number().int(), attempt: z.number().int().optional() }))
    .default([]),
  deleted: z.boolean().optional(),
});
const event = z.object({
  id: z.string(),
  occurred_at: z.number().int(),
  event_type: z.string(),
  content: z.object({ invoice: z.unknown().optional(), customer: z.unknown().optional() }),
});

const iso = (unix: number) => new Date(unix * 1000).toISOString();

function base(c: Credentials) {
  if (!c.site || !c.apiKey) throw new Error("Chargebee has no site or key");
  return `https://${c.site}.chargebee.com/api/v2`;
}
const auth = (c: Credentials) => ({
  authorization: `Basic ${Buffer.from(`${c.apiKey ?? ""}:`).toString("base64")}`,
});

const SUB_STATUS: Record<string, "ACTIVE" | "PAST_DUE" | "CANCELLED" | "ENDED"> = {
  active: "ACTIVE",
  in_trial: "ACTIVE",
  non_renewing: "ACTIVE",
  future: "ACTIVE",
  paused: "ENDED",
  cancelled: "CANCELLED",
};

const mapCustomer = (c: z.infer<typeof customer>) => ({
  externalId: c.id,
  email: c.email ?? undefined,
  name: c.company ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || undefined),
  deleted: c.deleted ?? false,
});

const mapSubscription = (s: z.infer<typeof subscription>) => ({
  externalId: s.id,
  customerExternalId: s.customer_id,
  plan: s.subscription_items[0]?.item_price_id ?? "",
  interval:
    s.billing_period_unit === "month"
      ? "MONTH"
      : s.billing_period_unit === "year"
        ? "YEAR"
        : s.billing_period_unit,
  amountMinor: s.subscription_items.reduce((n, i) => n + (i.amount ?? 0), 0),
  currency: s.currency_code,
  quantity: s.subscription_items.reduce((n, i) => n + (i.quantity ?? 1), 0),
  status: SUB_STATUS[s.status] ?? s.status,
  currentPeriodEnd: s.current_term_end ? iso(s.current_term_end) : undefined,
});

/** `failedAt` = a payment_failed event's time; otherwise the latest dunning attempt (both real). */
function mapInvoice(i: z.infer<typeof invoice>, failedAt?: number) {
  const lastAttempt = i.dunning_attempts.reduce<number | undefined>(
    (m, a) => Math.max(m ?? 0, a.created_at),
    undefined,
  );
  const unpaid = i.status === "payment_due" || i.status === "not_paid";
  const failed =
    unpaid && (i.dunning_attempts.length > 0 || i.status === "not_paid" || failedAt !== undefined);
  const lastFailure = failedAt ?? lastAttempt;
  const status =
    i.status === "paid" ? "PAID" : i.status === "voided" ? "VOID" : failed ? "FAILED" : "OPEN";
  return {
    externalId: i.id,
    customerExternalId: i.customer_id,
    subscriptionExternalId: i.subscription_id ?? undefined,
    number: i.id,
    amountMinor: i.total,
    currency: i.currency_code,
    issuedAt: iso(i.date),
    dueAt: iso(i.due_date ?? i.date),
    paidAt: i.paid_at ? iso(i.paid_at) : undefined,
    status,
    failureCount: failed ? Math.max(i.dunning_attempts.length, 1) : 0,
    lastFailedAt: failed && lastFailure ? iso(lastFailure) : undefined,
  };
}

/** The cursor as the text Chargebee accepts back: an array becomes its JSON text, a string stays. */
const offsetText = (o: string | string[] | null | undefined) =>
  o == null ? undefined : typeof o === "string" ? o : JSON.stringify(o);

async function* pages<T extends z.ZodType>(
  t: HttpTransport,
  c: Credentials,
  path: string,
  key: string,
  item: T,
  since?: string,
): AsyncGenerator<Array<z.infer<T>>> {
  let offset: string | undefined;
  for (;;) {
    const url = new URL(`${base(c)}${path}`);
    url.searchParams.set("limit", PAGE);
    if (since) url.searchParams.set("updated_at[after]", since);
    if (offset) url.searchParams.set("offset", offset);
    const body: z.infer<ReturnType<typeof listOf>> = await requestJson(
      t,
      { method: "GET", url: url.toString(), headers: auth(c) },
      listOf(key, item),
    );
    yield body.list.map((e) => e[key] as z.infer<T>);
    const next = offsetText(body.next_offset);
    if (!next) return;
    // A cursor that did not move would repeat the same page for ever.
    if (next === offset) throw new ProviderShapeError(`next_offset: repeated cursor ${next}`);
    offset = next;
  }
}

/** Constant-time check of the webhook's Basic credentials against this integration's own. */
export function verifyChargebeeBasicAuth(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const got = Buffer.from(header.slice(6).trim());
  const want = Buffer.from(Buffer.from(secret).toString("base64"));
  return got.length === want.length && timingSafeEqual(got, want);
}

function toEvents(payload: unknown): NormalizedEvent[] {
  const e = event.safeParse(payload);
  if (!e.success) return [];
  const { id, event_type: type, occurred_at, content } = e.data;
  if (type !== "payment_failed" && type !== "payment_succeeded") return [];
  const inv = invoice.safeParse(content.invoice);
  if (!inv.success) return [];
  const cust = customer.safeParse(content.customer);
  return [
    {
      externalEventId: id,
      type,
      batches: [
        ...(cust.success
          ? [{ kind: "customers" as const, records: [mapCustomer(cust.data)] }]
          : []),
        {
          kind: "invoices",
          records: [mapInvoice(inv.data, type === "payment_failed" ? occurred_at : undefined)],
        },
      ],
      realtimeCustomerExternalId: inv.data.customer_id,
    },
  ];
}

export const chargebeeAdapter: IntegrationAdapter<Cfg> = {
  provider: "CHARGEBEE",
  category: "BILLING",
  displayName: "Chargebee",
  configSchema: z.object({}).strip() as unknown as z.ZodType<Cfg>,
  auth: {
    kind: "apiKey",
    async validate(c, transport) {
      await requestJson(
        transport,
        { method: "GET", url: `${base(c)}/customers?limit=1`, headers: auth(c) },
        listOf("customer", customer),
      );
    },
  },
  async testConnection(ctx: AdapterContext<Cfg>) {
    const c = ctx.credentials;
    await requestJson(
      ctx.transport,
      { method: "GET", url: `${base(c)}/customers?limit=1`, headers: auth(c) },
      listOf("customer", customer),
    );
    return {
      ok: true,
      message: `Chargebee site ${c.site} accepted the key.`,
      externalAccountId: c.site,
    };
  },
  async *sync(ctx, opts): AsyncGenerator<NormalizedBatch> {
    const { transport: t, credentials: c } = ctx;
    const started = String(Math.floor(ctx.clock().getTime() / 1000));
    const since =
      opts.kind === "INCREMENTAL" && opts.cursor && /^\d+$/.test(opts.cursor)
        ? opts.cursor
        : undefined;
    for await (const p of pages(t, c, "/customers", "customer", customer, since))
      yield { kind: "customers", records: p.map(mapCustomer) };
    for await (const p of pages(t, c, "/subscriptions", "subscription", subscription, since))
      yield { kind: "subscriptions", records: p.filter((s) => !s.deleted).map(mapSubscription) };
    for await (const p of pages(t, c, "/invoices", "invoice", invoice, since))
      yield {
        kind: "invoices",
        records: p.filter((i) => !i.deleted && i.status !== "pending").map((i) => mapInvoice(i)),
      };
    yield { kind: "invoices", records: [], cursor: started };
  },
  webhook: {
    verify: (req, secret) => verifyChargebeeBasicAuth(req.headers.authorization, secret),
    toEvents,
  },
  describeError(err) {
    if (err instanceof ProviderHttpError && err.status === 401)
      return {
        plain: "The API key was rejected by Chargebee.",
        action: "Paste a new read-only key.",
      };
    return describeProviderError(err, "Chargebee", "Paste a new read-only key.");
  },
};
