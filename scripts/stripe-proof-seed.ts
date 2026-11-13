/**
 * Connector live proof B1 (docs/CONNECTOR-LIVE.md, Stripe): seeds the proof data in a Stripe TEST
 * account. Not product code; run by hand:
 *
 *   pnpm exec tsx --env-file=.env scripts/stripe-proof-seed.ts seed
 *   pnpm exec tsx --env-file=.env scripts/stripe-proof-seed.ts resume       (finish a partial seed)
 *   pnpm exec tsx --env-file=.env scripts/stripe-proof-seed.ts report       (read-only)
 *   pnpm exec tsx --env-file=.env scripts/stripe-proof-seed.ts change-beta
 *
 * Reads the key from STRIPE_PROOF_SEED_KEY and never prints it. Refuses any key that is not a test
 * key (sk_test_ / rk_test_). `seed` refuses to run if PROOF customers already exist (no duplicates).
 *
 * Seed: 3 customers (PROOF Alpha, Beta, Gamma) with billing emails on their own domains, one
 * product with one monthly USD price, and active subscriptions for Alpha (quantity 3) and Beta
 * (quantity 2) with fixed renewal dates (billing_cycle_anchor). "Send invoice" collection, so no
 * payment method is attached and nothing is charged.
 */
const API = "https://api.stripe.com/v1";

const PRICE_MINOR = 12_000; // USD 120.00 per unit per month
const ALPHA_QTY = 3; // USD 360.00 / month
const BETA_QTY = 2; // USD 240.00 / month
const BETA_QTY_CHANGED = 5; // USD 600.00 / month after step 5
const ALPHA_RENEWS = Date.UTC(2026, 11, 1) / 1000; // 2026-12-01T00:00:00Z
// Stripe allows the first renewal at most one billing period ahead (about 2026-12-13 on 2026-11-13).
const BETA_RENEWS = Date.UTC(2026, 11, 10) / 1000; // 2026-12-10T00:00:00Z

const CUSTOMERS = [
  { key: "alpha", name: "PROOF Alpha", email: "billing@proof-alpha.test" },
  { key: "beta", name: "PROOF Beta", email: "billing@proof-beta.test" },
  { key: "gamma", name: "PROOF Gamma", email: "billing@proof-gamma.test" },
] as const;

function key(): string {
  const k = process.env.STRIPE_PROOF_SEED_KEY ?? "";
  if (!/^(sk|rk)_test_/.test(k)) {
    throw new Error("STRIPE_PROOF_SEED_KEY is missing or is not a Stripe TEST key; refusing.");
  }
  return k;
}

async function stripe<T>(method: "GET" | "POST", path: string, form?: Record<string, string>) {
  const url =
    method === "GET" && form ? `${API}${path}?${new URLSearchParams(form)}` : `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${key()}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": "2025-03-31.basil",
    },
    body: method === "POST" && form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = (await res.json()) as T & { error?: { message?: string; type?: string } };
  if (!res.ok)
    throw new Error(
      `Stripe ${method} ${path} failed (HTTP ${res.status}): ${(body.error?.message ?? "no message").replace(/(sk|rk)_(test|live)_[^'\s]*/g, "<key>")}`,
    );
  return body;
}

type List<T> = { data: T[] };
type Customer = { id: string; name: string | null; email: string | null; livemode: boolean };
type Sub = {
  id: string;
  status: string;
  customer: string;
  items: {
    data: Array<{
      id: string;
      quantity: number;
      current_period_end?: number;
      price: { unit_amount: number };
    }>;
  };
};

const iso = (s: number | undefined) => (s ? new Date(s * 1000).toISOString() : "none");

async function seed() {
  for (const c of CUSTOMERS) {
    const found = await stripe<List<Customer>>("GET", "/customers", { email: c.email, limit: "1" });
    if (found.data.length)
      throw new Error(`${c.name} already exists in Stripe; refusing to duplicate.`);
  }
  const ids: Record<string, string> = {};
  for (const c of CUSTOMERS) {
    const cust = await stripe<Customer>("POST", "/customers", {
      name: c.name,
      email: c.email,
      "metadata[muster_proof]": "b1",
    });
    if (cust.livemode) throw new Error("Stripe answered in live mode; stopping.");
    ids[c.key] = cust.id;
  }
  const product = await stripe<{ id: string }>("POST", "/products", {
    name: "PROOF Plan",
    "metadata[muster_proof]": "b1",
  });
  const price = await stripe<{ id: string }>("POST", "/prices", {
    product: product.id,
    nickname: "PROOF Monthly",
    currency: "usd",
    unit_amount: String(PRICE_MINOR),
    "recurring[interval]": "month",
  });
  const subs: Sub[] = [];
  for (const [who, qty, anchor] of [
    ["alpha", ALPHA_QTY, ALPHA_RENEWS],
    ["beta", BETA_QTY, BETA_RENEWS],
  ] as const) {
    subs.push(
      await stripe<Sub>("POST", "/subscriptions", {
        customer: ids[who]!,
        "items[0][price]": price.id,
        "items[0][quantity]": String(qty),
        collection_method: "send_invoice",
        days_until_due: "30",
        billing_cycle_anchor: String(anchor),
        proration_behavior: "none",
        "metadata[muster_proof]": "b1",
      }),
    );
  }
  console.log("seeded (test mode)");
  for (const c of CUSTOMERS) console.log(`  customer ${c.name} <${c.email}> ${ids[c.key]}`);
  console.log(
    `  product ${product.id} PROOF Plan; price ${price.id} PROOF Monthly USD ${(PRICE_MINOR / 100).toFixed(2)}/unit/month`,
  );
  for (const s of subs) {
    const item = s.items.data[0]!;
    console.log(
      `  subscription ${s.id} customer ${s.customer} status ${s.status} qty ${item.quantity} = USD ${((item.price.unit_amount * item.quantity) / 100).toFixed(2)}/month, period end ${iso(item.current_period_end)}`,
    );
  }
}

/** The existing PROOF customers by key (none created here). */
async function existingCustomers(): Promise<Record<string, Customer>> {
  const out: Record<string, Customer> = {};
  for (const c of CUSTOMERS) {
    const found = await stripe<List<Customer>>("GET", "/customers", { email: c.email, limit: "1" });
    if (found.data[0]) out[c.key] = found.data[0];
  }
  return out;
}

/**
 * Finishes a seed that stopped part-way: reuses the PROOF customers and the PROOF Monthly price,
 * and creates only the subscriptions that are missing. Creates no customer, product or price.
 */
async function resume() {
  const custs = await existingCustomers();
  for (const c of CUSTOMERS)
    if (!custs[c.key]) throw new Error(`${c.name} is missing; run "seed" on a clean account.`);
  const prices = await stripe<
    List<{ id: string; nickname: string | null; unit_amount: number; active: boolean }>
  >("GET", "/prices", { limit: "100", active: "true" });
  const price = prices.data.find((p) => p.nickname === "PROOF Monthly");
  if (!price) throw new Error("The PROOF Monthly price is missing.");
  for (const [who, qty, anchor] of [
    ["alpha", ALPHA_QTY, ALPHA_RENEWS],
    ["beta", BETA_QTY, BETA_RENEWS],
  ] as const) {
    const have = await stripe<List<Sub>>("GET", "/subscriptions", {
      customer: custs[who]!.id,
      limit: "1",
    });
    if (have.data.length) {
      console.log(`  ${who}: subscription ${have.data[0]!.id} already exists, left as is`);
      continue;
    }
    const s = await stripe<Sub>("POST", "/subscriptions", {
      customer: custs[who]!.id,
      "items[0][price]": price.id,
      "items[0][quantity]": String(qty),
      collection_method: "send_invoice",
      days_until_due: "30",
      billing_cycle_anchor: String(anchor),
      proration_behavior: "none",
      "metadata[muster_proof]": "b1",
    });
    console.log(`  ${who}: created subscription ${s.id}`);
  }
  await report();
}

/** Read-only: what the PROOF data looks like in Stripe right now (evidence for the doc). */
async function report() {
  const custs = await existingCustomers();
  for (const c of CUSTOMERS) {
    const cu = custs[c.key];
    if (!cu) {
      console.log(`  ${c.name}: not found`);
      continue;
    }
    const subs = await stripe<List<Sub>>("GET", "/subscriptions", { customer: cu.id, limit: "10" });
    const line = subs.data
      .map((s) => {
        const it = s.items.data[0]!;
        return `${s.id} ${s.status} qty ${it.quantity} = USD ${((it.price.unit_amount * it.quantity) / 100).toFixed(2)}/month, renews ${iso(it.current_period_end)}`;
      })
      .join("; ");
    console.log(`  ${c.name} <${c.email}> ${cu.id}: ${line || "no subscription"}`);
    const inv = await stripe<
      List<{ id: string; status: string; total: number; currency: string; created: number }>
    >("GET", "/invoices", { customer: cu.id, limit: "10" });
    for (const i of inv.data)
      console.log(
        `      invoice ${i.id} ${i.status} ${i.currency.toUpperCase()} ${(i.total / 100).toFixed(2)} created ${iso(i.created)}`,
      );
  }
}

async function changeBeta() {
  const found = await stripe<List<Customer>>("GET", "/customers", {
    email: CUSTOMERS[1].email,
    limit: "1",
  });
  const beta = found.data[0];
  if (!beta) throw new Error("PROOF Beta not found");
  const subs = await stripe<List<Sub>>("GET", "/subscriptions", { customer: beta.id, limit: "1" });
  const s = subs.data[0];
  if (!s) throw new Error("PROOF Beta has no subscription");
  const item = s.items.data[0]!;
  const updated = await stripe<Sub>("POST", `/subscriptions/${s.id}`, {
    "items[0][id]": item.id,
    "items[0][quantity]": String(BETA_QTY_CHANGED),
    proration_behavior: "none",
  });
  const u = updated.items.data[0]!;
  console.log(
    `PROOF Beta ${s.id}: qty ${item.quantity} -> ${u.quantity}, USD ${((u.price.unit_amount * u.quantity) / 100).toFixed(2)}/month, period end ${iso(u.current_period_end)}`,
  );
}

const COMMANDS: Record<string, () => Promise<void>> = {
  seed,
  resume,
  report,
  "change-beta": changeBeta,
};
const run = COMMANDS[process.argv[2] ?? ""];
(run ? run() : Promise.reject(new Error("usage: seed | resume | report | change-beta"))).catch(
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  },
);
