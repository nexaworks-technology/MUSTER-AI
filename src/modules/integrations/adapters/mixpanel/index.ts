import { z } from "zod";
import { addDays, calendarDateOf, type CalendarDate } from "@/lib/dates";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedBatch } from "../../normalized";
import { ProviderHttpError, ProviderShapeError, type HttpTransport } from "../../transport";
import { foldUsage, type FoldEvent } from "../../usage-api/fold";

/**
 * Mixpanel (service account, read-only). Reads the raw event export one week at a time and folds
 * it, in memory, into one usage day per account (D-23: aggregates only; the events are dropped as
 * soon as the page is folded). Days are `SET`: re-reading a day gives the same numbers, so a
 * second sync changes nothing.
 *
 * Mapping (all configurable, nothing guessed): the account is the event property
 * `accountProperty`; the person is `$user_id`, else `distinct_id`; a feature is the event property
 * `featureProperty`; a session is an event named "Session Started". Events with no account
 * property are not attributable to a customer and are left out. `time` is read as the project's
 * own clock, so a day is the UTC date of that number (Mixpanel stores project-local seconds).
 *
 * Limits (M6 risk): the export API allows few calls per hour, so a FULL read (90 days) is 13
 * calls and an INCREMENTAL one re-reads the last two days (late events) in one.
 */
const FULL_DAYS = 90;
const CHUNK_DAYS = 7;
const OVERLAP_DAYS = 2;

const config = z.object({
  projectId: z.string().regex(/^\d{1,20}$/, "The project id is a number."),
  region: z.enum(["US", "EU"]).default("US"),
  accountProperty: z.string().trim().min(1).max(100).default("account_id"),
  featureProperty: z.string().trim().min(1).max(100).default("feature"),
});
type Cfg = z.infer<typeof config>;

const host = (c: Cfg) =>
  c.region === "EU" ? "https://data-eu.mixpanel.com" : "https://data.mixpanel.com";

function headers(c: Credentials): Record<string, string> {
  if (!c.username || !c.apiKey) throw new Error("Mixpanel has no saved service account");
  return {
    authorization: `Basic ${Buffer.from(`${c.username}:${c.apiKey}`).toString("base64")}`,
    accept: "text/plain",
  };
}

const exportEvent = z.object({
  event: z.string(),
  properties: z
    .object({ time: z.number(), distinct_id: z.union([z.string(), z.number()]).optional() })
    .passthrough(),
});

async function exportDays(
  transport: HttpTransport,
  cfg: Cfg,
  c: Credentials,
  from: CalendarDate,
  to: CalendarDate,
): Promise<unknown[]> {
  const url = new URL("/api/2.0/export", host(cfg));
  url.searchParams.set("project_id", cfg.projectId);
  url.searchParams.set("from_date", from);
  url.searchParams.set("to_date", to);
  const res = await transport.request({ method: "GET", url: url.toString(), headers: headers(c) });
  if (res.status < 200 || res.status >= 300) {
    const retry = Number(res.headers["retry-after"]);
    throw new ProviderHttpError(res.status, Number.isFinite(retry) ? retry : undefined);
  }
  if (typeof res.body !== "string")
    throw new ProviderShapeError("(root): the export was not newline-delimited text");
  const lines = res.body.split("\n").filter((l) => l.trim() !== "");
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new ProviderShapeError(`line ${i + 1}: not JSON`);
    }
  });
}

function toFold(raw: unknown[], cfg: Cfg, from: CalendarDate, to: CalendarDate): FoldEvent[] {
  const out: FoldEvent[] = [];
  for (const r of raw) {
    const parsed = exportEvent.safeParse(r);
    if (!parsed.success)
      throw new ProviderShapeError(
        `event: ${parsed.error.issues[0]?.path.join(".") || "(root)"}: ${parsed.error.issues[0]?.message}`,
      );
    const p = parsed.data.properties as Record<string, unknown>;
    const date = calendarDateOf(new Date(parsed.data.properties.time * 1000));
    if (date < from || date > to) continue;
    const account = p[cfg.accountProperty];
    const user = p["$user_id"] ?? p["distinct_id"];
    if (typeof account !== "string" && typeof account !== "number") continue;
    if (user === undefined || user === null || user === "") continue;
    const feature = p[cfg.featureProperty];
    out.push({
      groupRef: String(account),
      userId: String(user),
      date,
      name: parsed.data.event,
      feature: typeof feature === "string" && feature ? feature : undefined,
    });
  }
  return out;
}

export const mixpanelAdapter: IntegrationAdapter<Cfg> = {
  provider: "MIXPANEL",
  category: "USAGE",
  displayName: "Mixpanel",
  configSchema: config,
  auth: {
    kind: "apiKey",
    async validate(c, transport) {
      // Credentials are checked against the project they will read; config is validated at save.
      const probe = new URL("/api/2.0/export", "https://data.mixpanel.com");
      probe.searchParams.set("from_date", "2026-01-01");
      probe.searchParams.set("to_date", "2026-01-01");
      const res = await transport.request({
        method: "GET",
        url: probe.toString(),
        headers: headers(c),
      });
      if (res.status < 200 || res.status >= 300) throw new ProviderHttpError(res.status);
    },
  },
  async testConnection(ctx: AdapterContext<Cfg>) {
    const today = calendarDateOf((ctx.businessClock ?? ctx.clock)());
    await exportDays(ctx.transport, ctx.config, ctx.credentials, today, today);
    return {
      ok: true,
      message: `Mixpanel accepted the service account and project ${ctx.config.projectId} can be read.`,
      externalAccountId: ctx.config.projectId,
    };
  },
  async *sync(ctx, opts): AsyncGenerator<NormalizedBatch> {
    const today = calendarDateOf((ctx.businessClock ?? ctx.clock)());
    const start =
      opts.kind === "INCREMENTAL" && opts.cursor && /^\d{4}-\d{2}-\d{2}$/.test(opts.cursor)
        ? addDays(opts.cursor, -OVERLAP_DAYS)
        : addDays(today, -(FULL_DAYS - 1));
    for (let from = start; from <= today; from = addDays(from, CHUNK_DAYS)) {
      const to = addDays(from, CHUNK_DAYS - 1) < today ? addDays(from, CHUNK_DAYS - 1) : today;
      const raw = await exportDays(ctx.transport, ctx.config, ctx.credentials, from, to);
      yield {
        kind: "usage",
        records: foldUsage(toFold(raw, ctx.config, from, to), { mode: "SET" }),
      };
    }
    yield { kind: "usage", records: [], cursor: today };
  },
  describeError: (err) =>
    describeProviderError(
      err,
      "Mixpanel",
      "Paste the service account's user name and secret again (Project settings › Service accounts).",
    ),
};
