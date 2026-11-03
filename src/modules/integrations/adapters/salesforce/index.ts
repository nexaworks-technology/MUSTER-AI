import { z } from "zod";
import { env } from "@/lib/config/env";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedBatch } from "../../normalized";
import { ProviderHttpError, requestJson, type HttpTransport } from "../../transport";
import { employeeBand, toMinor } from "../shared";

/**
 * Salesforce (OAuth, REST + SOQL). Read-only by default: active Users → members by email
 * (unmatched listed), Accounts → accounts, Contacts → contacts, and won Opportunities →
 * contracts only when an Admin turns that on (D-88 applies the same way). Write-back declares the
 * account owner only, reachable through the gate (Rule 7, founder D2).
 *
 * Reads use `queryAll` so deleted rows come back with `IsDeleted = true` and keep their mappings
 * without touching the record. Pages follow `nextRecordsUrl`. INCREMENTAL adds
 * `LastModifiedDate >= <cursor>`; the cursor is the run's start (ISO). Salesforce does not say
 * when a session ends, so an expired session surfaces as a 401 and the sync engine refreshes once
 * and reads again (D-94).
 */
const LOGIN = "https://login.salesforce.com";
const API_VERSION = "v61.0";
export const SALESFORCE_SCOPES = ["api", "refresh_token"] as const;

export const salesforceConfig = z
  .object({
    /** Won opportunities become contracts (off by default: amounts are not always annual). */
    opportunitiesAsContracts: z.boolean().default(false),
  })
  .strip();
type Cfg = z.infer<typeof salesforceConfig>;

const record = z.record(z.string(), z.unknown());
const queryPage = z.object({
  totalSize: z.number().int(),
  done: z.boolean(),
  records: z.array(record),
  nextRecordsUrl: z.string().startsWith("/services/").optional(),
});
const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  instance_url: z.url(),
});
const org = z.object({
  records: z
    .array(z.object({ Id: z.string(), DefaultCurrencyIsoCode: z.string().nullable().optional() }))
    .min(1),
});

const str = (r: Record<string, unknown>, k: string) => {
  const v = r[k];
  return typeof v === "string" && v !== "" ? v : undefined;
};

function auth(c: Credentials): Record<string, string> {
  if (!c.accessToken || !c.instanceUrl) throw new Error("Salesforce has no session");
  return { authorization: `Bearer ${c.accessToken}` };
}

/** SOQL datetimes are unquoted ISO instants; only a cursor we wrote ourselves is used. */
const soqlInstant = (cursor: string | undefined) =>
  cursor && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(cursor) ? cursor : undefined;

async function* query(
  t: HttpTransport,
  c: Credentials,
  soql: string,
): AsyncGenerator<Array<Record<string, unknown>>> {
  let next: string | undefined =
    `/services/data/${API_VERSION}/queryAll?q=${encodeURIComponent(soql)}`;
  while (next) {
    const body: z.infer<typeof queryPage> = await requestJson(
      t,
      { method: "GET", url: `${c.instanceUrl}${next}`, headers: auth(c) },
      queryPage,
    );
    yield body.records;
    next = body.done ? undefined : body.nextRecordsUrl;
  }
}

function clientCredentials() {
  const e = env();
  if (!e.SALESFORCE_CLIENT_ID || !e.SALESFORCE_CLIENT_SECRET) {
    if (e.INTEGRATIONS_TRANSPORT === "fixture" || e.NODE_ENV === "test")
      return { client_id: "fixture-client", client_secret: "fixture-client-secret" };
    throw new Error("SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET are not set");
  }
  return { client_id: e.SALESFORCE_CLIENT_ID, client_secret: e.SALESFORCE_CLIENT_SECRET };
}

const tokenRequest = (form: Record<string, string>) => ({
  method: "POST" as const,
  url: `${LOGIN}/services/oauth2/token`,
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(form).toString(),
});

const where = (since: string | undefined, extra?: string) => {
  const parts = [extra, since ? `LastModifiedDate >= ${since}` : undefined].filter(Boolean);
  return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
};

export const salesforceAdapter: IntegrationAdapter<Cfg> = {
  provider: "SALESFORCE",
  category: "CRM",
  displayName: "Salesforce",
  configSchema: salesforceConfig as unknown as z.ZodType<Cfg>,
  auth: {
    kind: "oauth2",
    scopes: SALESFORCE_SCOPES,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(`${LOGIN}/services/oauth2/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientCredentials().client_id);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", SALESFORCE_SCOPES.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchange(code, redirectUri, transport) {
      const r = await requestJson(
        transport,
        tokenRequest({
          grant_type: "authorization_code",
          ...clientCredentials(),
          redirect_uri: redirectUri,
          code,
        }),
        tokens,
      );
      return {
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
        instanceUrl: r.instance_url,
      };
    },
    async refresh(c, transport) {
      if (!c.refreshToken) throw new Error("Salesforce has no refresh token");
      const r = await requestJson(
        transport,
        tokenRequest({
          grant_type: "refresh_token",
          ...clientCredentials(),
          refresh_token: c.refreshToken,
        }),
        tokens,
      );
      return {
        accessToken: r.access_token,
        refreshToken: r.refresh_token ?? c.refreshToken,
        instanceUrl: r.instance_url,
      };
    },
  },
  async testConnection(ctx: AdapterContext<Cfg>) {
    const c = ctx.credentials;
    const o = await requestJson(
      ctx.transport,
      {
        method: "GET",
        url: `${c.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent("SELECT Id, DefaultCurrencyIsoCode FROM Organization")}`,
        headers: auth(c),
      },
      org,
    );
    return {
      ok: true,
      message: `Connected to Salesforce org ${o.records[0]!.Id}. Read-only.`,
      externalAccountId: o.records[0]!.Id,
    };
  },
  async *sync(ctx, opts): AsyncGenerator<NormalizedBatch> {
    const { transport: t, credentials: c, config } = ctx;
    const started = ctx
      .clock()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const since = opts.kind === "INCREMENTAL" ? soqlInstant(opts.cursor) : undefined;

    for await (const page of query(t, c, "SELECT Id, Email, Name FROM User WHERE IsActive = true"))
      yield {
        kind: "owners",
        records: page.map((u) => ({
          externalId: str(u, "Id"),
          email: str(u, "Email"),
          name: str(u, "Name"),
        })),
      };

    for await (const page of query(
      t,
      c,
      `SELECT Id, Name, Website, OwnerId, Industry, NumberOfEmployees, IsDeleted FROM Account${where(since)}`,
    ))
      yield {
        kind: "accounts",
        records: page.map((a) => ({
          externalId: str(a, "Id"),
          name: str(a, "Name") ?? "",
          domain: str(a, "Website"),
          ownerExternalId: str(a, "OwnerId"),
          industry: str(a, "Industry"),
          employeeBand: employeeBand(a.NumberOfEmployees as number | null | undefined),
          archived: a.IsDeleted === true,
        })),
      };

    for await (const page of query(
      t,
      c,
      `SELECT Id, AccountId, FirstName, LastName, Email, Title, IsDeleted FROM Contact${where(since)}`,
    ))
      yield {
        kind: "contacts",
        records: page.map((p) => ({
          externalId: str(p, "Id"),
          accountExternalId: str(p, "AccountId"),
          name:
            [str(p, "FirstName"), str(p, "LastName")].filter(Boolean).join(" ") ||
            (str(p, "Email") ?? ""),
          email: str(p, "Email"),
          title: str(p, "Title"),
          archived: p.IsDeleted === true,
        })),
      };

    if (config.opportunitiesAsContracts) {
      const o = await requestJson(
        t,
        {
          method: "GET",
          url: `${c.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent("SELECT Id, DefaultCurrencyIsoCode FROM Organization")}`,
          headers: auth(c),
        },
        org,
      );
      const currency = o.records[0]!.DefaultCurrencyIsoCode ?? "";
      for await (const page of query(
        t,
        c,
        `SELECT Id, AccountId, Amount, CloseDate, IsDeleted FROM Opportunity${where(since, "IsWon = true")}`,
      ))
        yield {
          kind: "contracts",
          records: page
            .filter((op) => op.IsDeleted !== true)
            .map((op) => ({
              externalId: str(op, "Id"),
              accountExternalId: str(op, "AccountId") ?? "",
              startDate: str(op, "CloseDate"),
              valueMinor: toMinor(op.Amount as number | null | undefined),
              currency,
            })),
        };
    }
    yield { kind: "accounts", records: [], cursor: started };
  },
  writeBack: {
    fields: [{ key: "ownerMembershipId", label: "Account owner" }],
    async push(ctx, change) {
      if (change.field !== "ownerMembershipId")
        throw new Error("Salesforce writes only the account owner");
      const c = ctx.credentials;
      // Salesforce answers a successful update with 204 and no body.
      const res = await ctx.transport.request({
        method: "PATCH",
        url: `${c.instanceUrl}/services/data/${API_VERSION}/sobjects/Account/${encodeURIComponent(change.externalId)}`,
        headers: { ...auth(c), "content-type": "application/json" },
        body: JSON.stringify({ OwnerId: change.value }),
      });
      if (res.status !== 204 && res.status !== 200) throw new ProviderHttpError(res.status);
    },
  },
  describeError: (err) =>
    describeProviderError(err, "Salesforce", "Reconnect Salesforce from Settings › Integrations."),
};
