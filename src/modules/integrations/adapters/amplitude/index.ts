import { z } from "zod";
import { addDays, calendarDateOf, type CalendarDate } from "@/lib/dates";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedBatch, NormalizedUsageDay } from "../../normalized";
import { requestJson, type HttpTransport } from "../../transport";

/**
 * Amplitude (API key + secret key, read-only). Reads the Dashboard REST API's event segmentation,
 * which answers in daily totals per group, so no event ever reaches us (D-23). Per account and
 * day it reads active people (`_active`, uniques), events (`_all`, totals), sessions (the
 * configured session event, totals) and, for each feature the workspace mapped to an Amplitude
 * event, that feature's people and events. Days are `SET`: re-reading a day gives the same
 * numbers, so a second sync changes nothing. A day with no activity gets no row.
 *
 * Limits and the scope decision (Q-66): segmentation cannot list individual people, and the
 * export API that can returns zip files, so this adapter writes account and feature days only.
 * People-level rows, the power-user list, need the Usage API or Mixpanel. A segmentation group
 * shows at most 1,000 values, so more than 1,000 accounts needs a narrower `accountProperty`.
 */
const FULL_DAYS = 90;
const OVERLAP_DAYS = 2;

const config = z.object({
  region: z.enum(["US", "EU"]).default("US"),
  /** The value passed as `g`: a user property, e.g. "gp:account_id". */
  accountProperty: z.string().trim().min(1).max(100).default("gp:account_id"),
  sessionEvent: z.string().trim().min(1).max(200).default("Session Started"),
  /** Our feature key → the Amplitude event type that means "used it". */
  features: z.record(z.string().min(1).max(100), z.string().min(1).max(200)).default({}),
});
type Cfg = z.infer<typeof config>;

const host = (c: Cfg) =>
  c.region === "EU" ? "https://analytics.eu.amplitude.com" : "https://amplitude.com";

function headers(c: Credentials): Record<string, string> {
  if (!c.username || !c.apiKey) throw new Error("Amplitude has no saved keys");
  return {
    authorization: `Basic ${Buffer.from(`${c.username}:${c.apiKey}`).toString("base64")}`,
  };
}

const segmentation = z.object({
  data: z.object({
    series: z.array(z.array(z.number())),
    seriesMeta: z.array(z.string()).default([]),
    xValues: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  }),
});

/** group value → date → number */
type Series = Map<string, Map<string, number>>;

async function query(
  transport: HttpTransport,
  cfg: Cfg,
  c: Credentials,
  eventType: string,
  measure: "uniques" | "totals",
  from: CalendarDate,
  to: CalendarDate,
): Promise<Series> {
  const url = new URL("/api/2/events/segmentation", host(cfg));
  url.searchParams.set("e", JSON.stringify({ event_type: eventType }));
  url.searchParams.set("m", measure);
  url.searchParams.set("start", from.replaceAll("-", ""));
  url.searchParams.set("end", to.replaceAll("-", ""));
  url.searchParams.set("i", "1");
  url.searchParams.set("g", cfg.accountProperty);
  url.searchParams.set("limit", "1000");
  const body = await requestJson(
    transport,
    { method: "GET", url: url.toString(), headers: headers(c) },
    segmentation,
  );
  const out: Series = new Map();
  body.data.series.forEach((values, i) => {
    const group = body.data.seriesMeta[i];
    if (!group || group === "(none)") return;
    const byDate = new Map<string, number>();
    body.data.xValues.forEach((d, j) => byDate.set(d, values[j] ?? 0));
    out.set(group, byDate);
  });
  return out;
}

export const amplitudeAdapter: IntegrationAdapter<Cfg> = {
  provider: "AMPLITUDE",
  category: "USAGE",
  displayName: "Amplitude",
  configSchema: config,
  auth: {
    kind: "apiKey",
    async validate(c, transport, raw) {
      const today = calendarDateOf(new Date());
      await query(transport, config.parse(raw ?? {}), c, "_active", "uniques", today, today);
    },
  },
  async testConnection(ctx: AdapterContext<Cfg>) {
    const today = calendarDateOf((ctx.businessClock ?? ctx.clock)());
    await query(ctx.transport, ctx.config, ctx.credentials, "_active", "uniques", today, today);
    return { ok: true, message: "Amplitude accepted the keys and usage can be read." };
  },
  async *sync(ctx, opts): AsyncGenerator<NormalizedBatch> {
    const today = calendarDateOf((ctx.businessClock ?? ctx.clock)());
    const from =
      opts.kind === "INCREMENTAL" && opts.cursor && /^\d{4}-\d{2}-\d{2}$/.test(opts.cursor)
        ? addDays(opts.cursor, -OVERLAP_DAYS)
        : addDays(today, -(FULL_DAYS - 1));
    const { transport, config: cfg, credentials: c } = ctx;
    const q = (event: string, m: "uniques" | "totals") =>
      query(transport, cfg, c, event, m, from, today);
    const [active, events, sessions] = await Promise.all([
      q("_active", "uniques"),
      q("_all", "totals"),
      q(cfg.sessionEvent, "totals"),
    ]);
    const features = await Promise.all(
      Object.entries(cfg.features).map(async ([featureKey, event]) => ({
        featureKey,
        users: await q(event, "uniques"),
        events: await q(event, "totals"),
      })),
    );
    const records: NormalizedUsageDay[] = [];
    for (const [account, byDate] of events) {
      for (const [date, total] of byDate) {
        const people = active.get(account)?.get(date) ?? 0;
        if (total === 0 && people === 0) continue;
        records.push({
          accountExternalId: account,
          date,
          mode: "SET",
          events: total,
          sessions: sessions.get(account)?.get(date) ?? 0,
          activeUsers: people,
          users: [],
          features: features
            .map((f) => ({
              featureKey: f.featureKey,
              users: f.users.get(account)?.get(date) ?? 0,
              events: f.events.get(account)?.get(date) ?? 0,
            }))
            .filter((f) => f.events > 0),
        });
      }
    }
    yield { kind: "usage", records };
    yield { kind: "usage", records: [], cursor: today };
  },
  describeError: (err) =>
    describeProviderError(
      err,
      "Amplitude",
      "Paste the project's API key and secret key again (Settings › Projects).",
    ),
};
