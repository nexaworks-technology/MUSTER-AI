import type { z } from "zod";
import { env } from "@/lib/config/env";
import type { IntegrationProvider } from "@prisma/client";
import { createFixtureTransport, loadProviderFixtures } from "./fixture-transport";

/**
 * Every connector reaches its provider through one HttpTransport (D-82: hand-rolled REST, no
 * provider SDKs). Adapters never call `fetch` themselves (a test enforces it), so swapping the
 * transport is the whole difference between live, e2e and unit tests.
 */
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** Already encoded (JSON or form). */
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the response was JSON, otherwise the text. */
  body: unknown;
}

export interface HttpTransport {
  readonly mode: "live" | "fixture";
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** A non-2xx answer from a provider. `describeError` turns it into plain words. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Provider answered HTTP ${status}`);
    this.name = "ProviderHttpError";
  }
}

/** A 2xx answer whose body did not match the expected shape. Never "repaired". */
export class ProviderShapeError extends Error {
  constructor(readonly issues: string) {
    super(`Provider response had an unexpected shape: ${issues}`);
    this.name = "ProviderShapeError";
  }
}

/** The provider could not be reached at all (DNS, TLS, timeout). */
export class ProviderUnreachableError extends Error {
  constructor() {
    super("Provider could not be reached");
    this.name = "ProviderUnreachableError";
  }
}

/** Sends a request and Zod-parses the JSON body (CLAUDE.md: Zod-parse every external input). */
export async function requestJson<T>(
  transport: HttpTransport,
  req: HttpRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const res = await transport.request(req);
  if (res.status < 200 || res.status >= 300) {
    const retry = Number(res.headers["retry-after"]);
    throw new ProviderHttpError(res.status, Number.isFinite(retry) ? retry : undefined);
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success)
    throw new ProviderShapeError(
      parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
  return parsed.data;
}

const TIMEOUT_MS = 20_000;

/**
 * HTTPS to the provider. Header values (tokens) are never logged by this module. The timeout
 * covers the whole exchange, and any failure before the body is fully read (DNS, TLS, connect,
 * a reset or a timeout mid-body) is ProviderUnreachableError, so every connector words it as
 * "could not be reached" (CONNECTOR-LIVE.md, B1 finding 1).
 */
export function createLiveTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return {
    mode: "live",
    async request(req) {
      let res: Response;
      let text: string;
      try {
        res = await fetchImpl(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        text = await res.text();
      } catch {
        throw new ProviderUnreachableError();
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      let body: unknown = text;
      if ((headers["content-type"] ?? "").includes("json") && text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: res.status, headers, body };
    },
  };
}

/**
 * The transport for a provider, chosen by INTEGRATIONS_TRANSPORT. Under NODE_ENV=test a live
 * transport is refused outright (M5 rule 5): a test that forgets to inject a fake fails loudly
 * instead of reaching the network.
 */
export function transportFor(provider: IntegrationProvider): HttpTransport {
  const e = env();
  if (e.INTEGRATIONS_TRANSPORT === "fixture")
    return createFixtureTransport(loadProviderFixtures(provider));
  if (e.NODE_ENV === "test")
    throw new Error(
      "Tests never call live services: inject a fixture transport or set INTEGRATIONS_TRANSPORT=fixture.",
    );
  return createLiveTransport();
}
