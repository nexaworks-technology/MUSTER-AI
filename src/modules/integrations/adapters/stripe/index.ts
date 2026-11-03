import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedBatch, NormalizedEvent } from "../../normalized";
import { requestJson, type HttpTransport } from "../../transport";

/**
 * Stripe (API key; a restricted read-only key is recommended). Read-only: customers are matched
 * to existing accounts (D-84), subscriptions and invoices land through ingest. Webhooks:
 * invoice.payment_failed, invoice.paid, customer.subscription.updated, verified with the
 * integration's own endpoint secret (`Stripe-Signature`, 5-minute tolerance).
 *
 * Sync (D-87): Stripe lists are cheap and invoice status changes do not move `created`, so every
 * run reads customers and subscriptions in full and invoices created in the last 400 days; between
 * runs, webhooks carry the changes. The cursor records when the run read Stripe.
 */
const API = "https://api.stripe.com";
const PAGE = 100;
const INVOICE_WINDOW_DAYS = 400;
const TOLERANCE_SECONDS = 300;

type Cfg = Record<string, never>;

const list = <T extends z.ZodType>(item: T) =>
  z.object({ object: z.literal("list"), data: z.array(item), has_more: z.boolean() });

const customer = z.object({
  id: z.string(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  deleted: z.boolean().optional(),
});

const price = z.object({
  id: z.string(),
  nickname: z.string().nullable().optional(),
  product: z
    .union([z.string(), z.object({ id: z.string(), name: z.string().optional() })])
    .optional(),
  unit_amount: z.number().int().nullable(),
  currency: z.string(),
  recurring: z.object({ interval: z.string() }).nullable().optional(),
});

const subscription = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  current_period_end: z.number().int().optional(),
  items: z.object({
    data: z.array(
      z.object({
        price,
        quantity: z.number().int().optional(),
        current_period_end: z.number().int().optional(),
      }),
    ),
  }),
});

const invoice = z.object({
  id: z.string(),
  customer: z.string(),
  customer_email: z.string().nullable().optional(),
  customer_name: z.string().nullable().optional(),
  subscription: z.string().nullable().optional(),
  number: z.string().nullable(),
  amount_due: z.number().int(),
  currency: z.string(),
  created: z.number().int(),
  due_date: z.number().int().nullable().optional(),
  status: z.enum(["draft", "open", "paid", "uncollectible", "void"]).nullable(),
  attempt_count: z.number().int().default(0),
  status_transitions: z.object({ paid_at: z.number().int().nullable().optional() }).optional(),
  /** Expanded latest charge: its `created` is the real time of a failed attempt. */
  charge: z
    .union([
      z.string(),
      z.object({ id: z.string(), status: z.string(), created: z.number().int() }),
    ])
    .nullable()
    .optional(),
});

const event = z.object({
  id: z.string(),
  type: z.string(),
  created: z.number().int(),
  data: z.object({ object: z.unknown() }),
});

const iso = (unix: number) => new Date(unix * 1000).toISOString();

const SUB_STATUS: Record<string, "ACTIVE" | "PAST_DUE" | "CANCELLED" | "ENDED"> = {
  active: "ACTIVE",
  trialing: "ACTIVE",
  past_due: "PAST_DUE",
  unpaid: "PAST_DUE",
  incomplete: "PAST_DUE",
  canceled: "CANCELLED",
  incomplete_expired: "ENDED",
  paused: "ENDED",
};

function mapCustomer(c: z.infer<typeof customer>) {
  return {
    externalId: c.id,
    email: c.email ?? undefined,
    name: c.name ?? undefined,
    deleted: c.deleted ?? false,
  };
}

/** Records the normalized schemas will reject (e.g. a weekly interval) are left for ingest to explain. */
function mapSubscription(s: z.infer<typeof subscription>) {
  const items = s.items.data;
  const first = items[0]?.price;
  const amount = items.reduce((sum, i) => sum + (i.price.unit_amount ?? 0) * (i.quantity ?? 1), 0);
  const productName = first && typeof first.product === "object" ? first.product.name : undefined;
  const interval = first?.recurring?.interval;
  const periodEnd = s.current_period_end ?? items[0]?.current_period_end;
  return {
    externalId: s.id,
    customerExternalId: s.customer,
    plan: first?.nickname ?? productName ?? first?.id ?? "",
    interval: interval === "month" ? "MONTH" : interval === "year" ? "YEAR" : interval,
    amountMinor: amount,
    currency: first?.currency ?? "",
    quantity: items.reduce((n, i) => n + (i.quantity ?? 1), 0),
    status: SUB_STATUS[s.status] ?? s.status,
    currentPeriodEnd: periodEnd ? iso(periodEnd) : undefined,
  };
}

function mapInvoice(i: z.infer<typeof invoice>, failedAt?: number) {
  const charge = typeof i.charge === "object" && i.charge ? i.charge : undefined;
  const lastFailure = failedAt ?? (charge?.status === "failed" ? charge.created : undefined);
  const unpaid = i.status === "open";
  const failed = unpaid && (i.attempt_count > 0 || failedAt !== undefined);
  const status =
    i.status === "paid"
      ? "PAID"
      : i.status === "void"
        ? "VOID"
        : i.status === "uncollectible"
          ? "UNCOLLECTIBLE"
          : failed
            ? "FAILED"
            : "OPEN";
  return {
    externalId: i.id,
    customerExternalId: i.customer,
    subscriptionExternalId: i.subscription ?? undefined,
    number: i.number ?? i.id,
    amountMinor: i.amount_due,
    currency: i.currency,
    issuedAt: iso(i.created),
    // Charged automatically = no due date: payment was due when it was issued.
    dueAt: iso(i.due_date ?? i.created),
    paidAt: i.status_transitions?.paid_at ? iso(i.status_transitions.paid_at) : undefined,
    status,
    failureCount: failed ? Math.max(i.attempt_count, 1) : 0,
    lastFailedAt: failed && lastFailure ? iso(lastFailure) : undefined,
  };
}

function headers(c: Credentials): Record<string, string> {
  if (!c.apiKey) throw new Error("Stripe has no saved key");
  return { authorization: `Bearer ${c.apiKey}` };
}

async function* pages<T extends z.ZodType>(
  transport: HttpTransport,
  c: Credentials,
  path: string,
  params: Record<string, string>,
  item: T,
): AsyncGenerator<Array<z.infer<T>>> {
  let after: string | undefined;
  for (;;) {
    const url = new URL(path, API);
    url.searchParams.set("limit", String(PAGE));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (after) url.searchParams.set("starting_after", after);
    const body = await requestJson(
      transport,
      { method: "GET", url: url.toString(), headers: headers(c) },
      list(item),
    );
    yield body.data;
    if (!body.has_more || body.data.length === 0) return;
    after = (body.data.at(-1) as { id: string }).id;
  }
}

export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  now: Date,
): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  return sigs.some((s) => {
    const got = Buffer.from(s);
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

function toEvents(payload: unknown): NormalizedEvent[] {
  const e = event.safeParse(payload);
  if (!e.success) return [];
  const { id, type, created, data } = e.data;
  if (type === "invoice.payment_failed" || type === "invoice.paid") {
    const inv = invoice.safeParse(data.object);
    if (!inv.success) return [];
    const i = inv.data;
    return [
      {
        externalEventId: id,
        type,
        batches: [
          {
            kind: "customers",
            records: [
              {
                externalId: i.customer,
                email: i.customer_email ?? undefined,
                name: i.customer_name ?? undefined,
              },
            ],
          },
          {
            kind: "invoices",
            records: [mapInvoice(i, type === "invoice.payment_failed" ? created : undefined)],
          },
        ],
        realtimeCustomerExternalId: i.customer,
      },
    ];
  }
  if (type === "customer.subscription.updated") {
    const s = subscription.safeParse(data.object);
    if (!s.success) return [];
    return [
      {
        externalEventId: id,
        type,
        batches: [{ kind: "subscriptions", records: [mapSubscription(s.data)] }],
      },
    ];
  }
  return [];
}

export const stripeAdapter: IntegrationAdapter<Cfg> = {
  provider: "STRIPE",
  category: "BILLING",
  displayName: "Stripe",
  configSchema: z.object({}).strip() as unknown as z.ZodType<Cfg>,
  auth: {
    kind: "apiKey",
    async validate(c, transport) {
      await requestJson(
        transport,
        { method: "GET", url: `${API}/v1/customers?limit=1`, headers: headers(c) },
        list(customer),
      );
    },
  },
  async testConnection(ctx: AdapterContext<Cfg>) {
    await requestJson(
      ctx.transport,
      { method: "GET", url: `${API}/v1/customers?limit=1`, headers: headers(ctx.credentials) },
      list(customer),
    );
    return { ok: true, message: "Stripe accepted the key and customers can be read." };
  },
  async *sync(ctx): AsyncGenerator<NormalizedBatch> {
    const c = ctx.credentials;
    const startedAt = Math.floor(ctx.clock().getTime() / 1000);
    for await (const page of pages(ctx.transport, c, "/v1/customers", {}, customer))
      yield { kind: "customers", records: page.map(mapCustomer) };
    for await (const page of pages(
      ctx.transport,
      c,
      "/v1/subscriptions",
      { status: "all" },
      subscription,
    ))
      yield { kind: "subscriptions", records: page.map(mapSubscription) };
    const since = String(startedAt - INVOICE_WINDOW_DAYS * 86_400);
    for await (const page of pages(
      ctx.transport,
      c,
      "/v1/invoices",
      { "created[gte]": since, "expand[]": "data.charge" },
      invoice,
    ))
      yield {
        kind: "invoices",
        // Drafts are not bills yet.
        records: page.filter((i) => i.status && i.status !== "draft").map((i) => mapInvoice(i)),
      };
    yield { kind: "invoices", records: [], cursor: String(startedAt) };
  },
  webhook: {
    verify: (req, secret, now) =>
      verifyStripeSignature(req.rawBody, req.headers["stripe-signature"], secret, now),
    toEvents,
  },
  describeError: (err) =>
    describeProviderError(err, "Stripe", "Paste a new restricted read-only key."),
};
