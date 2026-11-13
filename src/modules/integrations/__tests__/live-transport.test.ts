import { describe, expect, it } from "vitest";
import { describeProviderError } from "../errors";
import { createLiveTransport, ProviderUnreachableError } from "../transport";

/**
 * The shared live HTTP layer (CONNECTOR-LIVE.md, B1 finding 1): a failure while the response body
 * is still arriving (timeout, reset) is the same "could not be reached" as a failed connect, for
 * every connector. Before the fix the body read sat outside the error handling and surfaced as
 * "stopped because of an unexpected error".
 */
const req = { method: "GET" as const, url: "https://api.example.test/v1/things" };

/** A Response whose headers arrive but whose body read fails with `err`. */
function brokenBody(err: unknown): typeof fetch {
  return (async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(err);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

describe("live transport errors", () => {
  it("reports a timeout while reading the body as unreachable", async () => {
    const t = createLiveTransport(brokenBody(timeout()));
    await expect(t.request(req)).rejects.toBeInstanceOf(ProviderUnreachableError);
  });

  it("reports a connection reset while reading the body as unreachable", async () => {
    const t = createLiveTransport(brokenBody(new TypeError("terminated")));
    await expect(t.request(req)).rejects.toBeInstanceOf(ProviderUnreachableError);
  });

  it("still reports a failed connect as unreachable", async () => {
    const t = createLiveTransport((async () => {
      throw timeout();
    }) as typeof fetch);
    await expect(t.request(req)).rejects.toBeInstanceOf(ProviderUnreachableError);
  });

  it("returns parsed JSON for a healthy answer", async () => {
    const t = createLiveTransport(
      (async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    await expect(t.request(req)).resolves.toMatchObject({ status: 200, body: { ok: 1 } });
  });

  it.each(["Stripe", "HubSpot", "Zendesk", "Gmail"])(
    "words a body-read timeout for %s as could not be reached",
    async (provider) => {
      const t = createLiveTransport(brokenBody(timeout()));
      const err = await t.request(req).catch((e: unknown) => e);
      expect(describeProviderError(err, provider, "x").plain).toBe(
        `${provider} could not be reached.`,
      );
    },
  );
});
