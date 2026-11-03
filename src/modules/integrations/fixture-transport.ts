import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { IntegrationProvider } from "@prisma/client";
import type { HttpRequest, HttpResponse, HttpTransport } from "./transport";

/**
 * Recorded-payload transport (M5 rule 5, D-85). Test, e2e and demo tooling only: env refuses
 * INTEGRATIONS_TRANSPORT=fixture in production. Fixtures are fictional JSON under
 * `adapters/<provider>/__fixtures__/`. A request that matches no recorded interaction throws
 * UnfixturedRequestError: nothing ever falls through to the network.
 */
const interaction = z.object({
  /** Free text for people reading the fixture. */
  note: z.string().optional(),
  request: z.object({
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    /** Path only (host is ignored, so one fixture serves any instance URL). */
    path: z.string().startsWith("/"),
    /**
     * Every listed key must match exactly; unlisted query keys are ignored. A value starting with
     * "~" matches when the request's value contains the rest (long SOQL queries).
     */
    query: z.record(z.string(), z.string()).optional(),
    /** Every listed header must match exactly (e.g. an expired vs a refreshed bearer token). */
    headers: z.record(z.string(), z.string()).optional(),
    /** When set, the request body must contain this text. */
    bodyIncludes: z.string().optional(),
  }),
  response: z.object({
    status: z.number().int(),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.unknown(),
  }),
});
export type FixtureInteraction = z.infer<typeof interaction>;

export const fixtureFile = z.object({
  provider: z.string(),
  description: z.string(),
  interactions: z.array(interaction).min(1),
});

export class UnfixturedRequestError extends Error {
  constructor(req: HttpRequest) {
    const u = new URL(req.url);
    super(`No recorded fixture for ${req.method} ${u.pathname}${u.search} — refusing to go live.`);
    this.name = "UnfixturedRequestError";
  }
}

function matches(i: FixtureInteraction, req: HttpRequest, url: URL): boolean {
  if (i.request.method !== req.method || i.request.path !== url.pathname) return false;
  for (const [k, v] of Object.entries(i.request.query ?? {})) {
    const got = url.searchParams.get(k);
    if (v.startsWith("~") ? !got?.includes(v.slice(1)) : got !== v) return false;
  }
  for (const [k, v] of Object.entries(i.request.headers ?? {}))
    if (req.headers?.[k.toLowerCase()] !== v && req.headers?.[k] !== v) return false;
  if (i.request.bodyIncludes && !(req.body ?? "").includes(i.request.bodyIncludes)) return false;
  return true;
}

export interface FixtureTransport extends HttpTransport {
  /** Every request seen, in order (tests assert on paging and auth headers). */
  readonly calls: HttpRequest[];
  /** Requests that had no fixture; a non-empty list fails the test that made them. */
  readonly unmatched: HttpRequest[];
}

/**
 * First match wins, so a fixture lists the most specific interaction (e.g. a query with a cursor)
 * before the general one.
 */
export function createFixtureTransport(interactions: FixtureInteraction[]): FixtureTransport {
  const calls: HttpRequest[] = [];
  const unmatched: HttpRequest[] = [];
  return {
    mode: "fixture",
    calls,
    unmatched,
    async request(req): Promise<HttpResponse> {
      calls.push(req);
      const url = new URL(req.url);
      const hit = interactions.find((i) => matches(i, req, url));
      if (!hit) {
        unmatched.push(req);
        throw new UnfixturedRequestError(req);
      }
      return {
        status: hit.response.status,
        headers: Object.fromEntries(
          Object.entries(hit.response.headers).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        body: structuredClone(hit.response.body),
      };
    },
  };
}

const ADAPTERS_DIR = path.join(process.cwd(), "src", "modules", "integrations", "adapters");

/** Reads one fixture file of a provider (`<name>.json`). */
export function loadFixture(provider: string, name: string): FixtureInteraction[] {
  const file = path.join(ADAPTERS_DIR, provider, "__fixtures__", `${name}.json`);
  return fixtureFile.parse(JSON.parse(readFileSync(file, "utf8"))).interactions;
}

/**
 * The "happy" recorded world of a provider for e2e and the demo: every `*.json` in its fixture
 * folder except error scenarios (`error-*`) and webhook bodies (`webhook-*`).
 */
export function loadProviderFixtures(provider: IntegrationProvider): FixtureInteraction[] {
  const dir = path.join(ADAPTERS_DIR, provider.toLowerCase(), "__fixtures__");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter(
      (f) => f.endsWith(".json") && !f.startsWith("error-") && !f.startsWith("webhook-"),
    );
  } catch {
    names = [];
  }
  return names.sort().flatMap((f) => loadFixture(provider.toLowerCase(), f.replace(/\.json$/, "")));
}
