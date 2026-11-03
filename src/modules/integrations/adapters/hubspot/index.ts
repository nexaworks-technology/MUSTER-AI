import { z } from "zod";
import { env } from "@/lib/config/env";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedBatch } from "../../normalized";
import { requestJson, type HttpTransport } from "../../transport";
import { employeeBand, toMinor } from "../shared";

/**
 * HubSpot (OAuth). Read-only by default: owners → members by email (unmatched listed),
 * companies → accounts, contacts → contacts, and closed-won deals → contracts only when the
 * Admin turns that on (D-88). Write-back declares one field, the account owner, reachable only
 * through the write-back gate (Rule 7, founder D2).
 *
 * FULL lists every object (archived companies too, so their mappings are kept). INCREMENTAL
 * searches companies, contacts and deals modified since the last good run's cursor (the run's
 * start time in ms). Owners are always read in full: there are few and they change rarely.
 */
const API = "https://api.hubapi.com";
const AUTH = "https://app.hubspot.com/oauth/authorize";
const PAGE = 100;
export const HUBSPOT_SCOPES = [
  "crm.objects.companies.read",
  "crm.objects.contacts.read",
  "crm.objects.deals.read",
  "crm.objects.owners.read",
  "crm.objects.companies.write",
] as const;

export const hubspotConfig = z
  .object({
    /** Closed-won deals become contracts (off by default: deal amounts are not always annual). */
    dealsAsContracts: z.boolean().default(false),
    closedWonStage: z.string().default("closedwon"),
  })
  .strip();
type Cfg = z.infer<typeof hubspotConfig>;

const COMPANY_PROPS = ["name", "domain", "hubspot_owner_id", "industry", "numberofemployees"];
const CONTACT_PROPS = ["firstname", "lastname", "email", "jobtitle", "associatedcompanyid"];
const DEAL_PROPS = ["amount", "closedate", "dealstage", "deal_currency_code", "pipeline"];

const paged = <T extends z.ZodType>(item: T) =>
  z.object({
    results: z.array(item),
    paging: z.object({ next: z.object({ after: z.string() }).optional() }).optional(),
  });

const props = z.record(z.string(), z.string().nullable().optional());
const object = z.object({ id: z.string(), properties: props, archived: z.boolean().optional() });
const owner = z.object({
  id: z.string(),
  email: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});
const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
});
const accountInfo = z.object({
  portalId: z.number().int(),
  companyCurrency: z.string().length(3).optional(),
});

const p = (o: z.infer<typeof object>, k: string) => o.properties[k] ?? undefined;

const titleCase = (v: string | undefined) =>
  v
    ? v
        .toLowerCase()
        .replace(/(^|_)([a-z])/g, (_m, s: string, c: string) => `${s ? " " : ""}${c.toUpperCase()}`)
    : undefined;

const mapCompany = (o: z.infer<typeof object>) => ({
  externalId: o.id,
  name: p(o, "name") ?? "",
  domain: p(o, "domain"),
  ownerExternalId: p(o, "hubspot_owner_id"),
  industry: titleCase(p(o, "industry")),
  employeeBand: employeeBand(p(o, "numberofemployees")),
  archived: o.archived ?? false,
});

const mapContact = (o: z.infer<typeof object>) => ({
  externalId: o.id,
  accountExternalId: p(o, "associatedcompanyid"),
  name: [p(o, "firstname"), p(o, "lastname")].filter(Boolean).join(" ") || (p(o, "email") ?? ""),
  email: p(o, "email"),
  title: p(o, "jobtitle"),
  archived: o.archived ?? false,
});

function auth(c: Credentials): Record<string, string> {
  if (!c.accessToken) throw new Error("HubSpot has no access token");
  return { authorization: `Bearer ${c.accessToken}` };
}

async function* listAll<T extends z.ZodType>(
  t: HttpTransport,
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
    if (after) url.searchParams.set("after", after);
    const body = await requestJson(
      t,
      { method: "GET", url: url.toString(), headers: auth(c) },
      paged(item),
    );
    yield body.results;
    after = body.paging?.next?.after;
    if (!after) return;
  }
}

async function* searchSince(
  t: HttpTransport,
  c: Credentials,
  objectType: string,
  properties: string[],
  sinceMs: string,
): AsyncGenerator<Array<z.infer<typeof object>>> {
  let after: string | undefined;
  for (;;) {
    const body = await requestJson(
      t,
      {
        method: "POST",
        url: `${API}/crm/v3/objects/${objectType}/search`,
        headers: { ...auth(c), "content-type": "application/json" },
        body: JSON.stringify({
          filterGroups: [
            { filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: sinceMs }] },
          ],
          properties,
          limit: PAGE,
          ...(after ? { after } : {}),
        }),
      },
      paged(object),
    );
    yield body.results;
    after = body.paging?.next?.after;
    if (!after) return;
  }
}

function tokenRequest(form: Record<string, string>) {
  return {
    method: "POST" as const,
    url: `${API}/oauth/v1/token`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  };
}

const toCredentials = (r: z.infer<typeof tokens>, now: Date): Credentials => ({
  accessToken: r.access_token,
  refreshToken: r.refresh_token,
  expiresAt: new Date(now.getTime() + r.expires_in * 1000).toISOString(),
});

function clientCredentials() {
  const e = env();
  if (!e.HUBSPOT_CLIENT_ID || !e.HUBSPOT_CLIENT_SECRET) {
    if (e.INTEGRATIONS_TRANSPORT === "fixture" || e.NODE_ENV === "test")
      return { client_id: "fixture-client", client_secret: "fixture-client-secret" };
    throw new Error("HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET are not set");
  }
  return { client_id: e.HUBSPOT_CLIENT_ID, client_secret: e.HUBSPOT_CLIENT_SECRET };
}

export const hubspotAdapter: IntegrationAdapter<Cfg> = {
  provider: "HUBSPOT",
  category: "CRM",
  displayName: "HubSpot",
  configSchema: hubspotConfig as unknown as z.ZodType<Cfg>,
  auth: {
    kind: "oauth2",
    scopes: HUBSPOT_SCOPES,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(AUTH);
      url.searchParams.set("client_id", clientCredentials().client_id);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", HUBSPOT_SCOPES.join(" "));
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
      return toCredentials(r, new Date());
    },
    async refresh(c, transport) {
      if (!c.refreshToken) throw new Error("HubSpot has no refresh token");
      const r = await requestJson(
        transport,
        tokenRequest({
          grant_type: "refresh_token",
          ...clientCredentials(),
          refresh_token: c.refreshToken,
        }),
        tokens,
      );
      return { ...toCredentials(r, new Date()), refreshToken: r.refresh_token ?? c.refreshToken };
    },
  },
  async testConnection(ctx: AdapterContext<Cfg>) {
    const info = await requestJson(
      ctx.transport,
      { method: "GET", url: `${API}/account-info/v3/details`, headers: auth(ctx.credentials) },
      accountInfo,
    );
    return {
      ok: true,
      message: `Connected to HubSpot portal ${info.portalId}. Read-only.`,
      externalAccountId: String(info.portalId),
    };
  },
  async *sync(ctx, opts): AsyncGenerator<NormalizedBatch> {
    const { transport: t, credentials: c, config } = ctx;
    const startedMs = String(ctx.clock().getTime());
    const since =
      opts.kind === "INCREMENTAL" && opts.cursor && /^\d+$/.test(opts.cursor)
        ? opts.cursor
        : undefined;

    for await (const page of listAll(t, c, "/crm/v3/owners", {}, owner))
      yield {
        kind: "owners",
        records: page
          .filter((o) => !o.archived)
          .map((o) => ({
            externalId: o.id,
            email: o.email ?? undefined,
            name: [o.firstName, o.lastName].filter(Boolean).join(" ") || undefined,
          })),
      };

    const companyPages = since
      ? searchSince(t, c, "companies", COMPANY_PROPS, since)
      : listAll(t, c, "/crm/v3/objects/companies", { properties: COMPANY_PROPS.join(",") }, object);
    for await (const page of companyPages)
      yield { kind: "accounts", records: page.map(mapCompany) };
    if (!since)
      for await (const page of listAll(
        t,
        c,
        "/crm/v3/objects/companies",
        { properties: COMPANY_PROPS.join(","), archived: "true" },
        object,
      ))
        yield {
          kind: "accounts",
          records: page.map((o) => ({ ...mapCompany(o), archived: true })),
        };

    const contactPages = since
      ? searchSince(t, c, "contacts", CONTACT_PROPS, since)
      : listAll(t, c, "/crm/v3/objects/contacts", { properties: CONTACT_PROPS.join(",") }, object);
    for await (const page of contactPages)
      yield { kind: "contacts", records: page.map(mapContact) };

    if (config.dealsAsContracts) {
      const info = await requestJson(
        t,
        { method: "GET", url: `${API}/account-info/v3/details`, headers: auth(c) },
        accountInfo,
      );
      const dealPages = since
        ? searchSince(t, c, "deals", [...DEAL_PROPS, "associatedcompanyid"], since)
        : listAll(
            t,
            c,
            "/crm/v3/objects/deals",
            { properties: [...DEAL_PROPS, "associatedcompanyid"].join(",") },
            object,
          );
      for await (const page of dealPages)
        yield {
          kind: "contracts",
          records: page
            .filter((d) => p(d, "dealstage") === config.closedWonStage && !d.archived)
            .map((d) => ({
              externalId: d.id,
              accountExternalId: p(d, "associatedcompanyid") ?? "",
              startDate: p(d, "closedate"),
              valueMinor: toMinor(p(d, "amount")),
              currency: p(d, "deal_currency_code") ?? info.companyCurrency ?? "",
            })),
        };
    }
    yield { kind: "accounts", records: [], cursor: startedMs };
  },
  writeBack: {
    fields: [{ key: "ownerMembershipId", label: "Account owner" }],
    async push(ctx, change) {
      if (change.field !== "ownerMembershipId")
        throw new Error("HubSpot writes only the account owner");
      await requestJson(
        ctx.transport,
        {
          method: "PATCH",
          url: `${API}/crm/v3/objects/companies/${encodeURIComponent(change.externalId)}`,
          headers: { ...auth(ctx.credentials), "content-type": "application/json" },
          body: JSON.stringify({ properties: { hubspot_owner_id: change.value } }),
        },
        z.object({ id: z.string() }),
      );
    },
  },
  describeError: (err) =>
    describeProviderError(err, "HubSpot", "Reconnect HubSpot from Settings › Integrations."),
};
