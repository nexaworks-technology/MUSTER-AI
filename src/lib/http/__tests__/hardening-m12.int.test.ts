import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeRateLimit } from "@/lib/rate-limit";
import { BodyTooLargeError, readCapped, readCappedText } from "../body";
import { clientIp } from "../client-ip";
import { AUTH_FAILURE_BLOCK, guardAuthFailures, limitOrRefuse, noteAuthFailure } from "../guard";

/**
 * M12 A9 (test-first). Each control is proven by a refusal, not by a config value:
 * - the body reader stops a chunked body with NO Content-Length once it passes the cap (streaming);
 * - after AUTH_FAILURE_BLOCK.limit 401s from one IP, that IP is refused (429) until the window ends;
 * - an endpoint limit refuses the request after its limit.
 */
const enc = new TextEncoder();
function chunked(totalBytes: number, chunk = 1024) {
  let sent = 0;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      if (sent >= totalBytes) return c.close();
      const n = Math.min(chunk, totalBytes - sent);
      sent += n;
      c.enqueue(new Uint8Array(n).fill(97));
    },
  });
  const req = new Request("http://localhost/x", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { req, pulls: () => pulls };
}

afterAll(async () => {
  await closeRateLimit();
});

describe("streaming body cap", () => {
  it("refuses a chunked body without Content-Length as soon as it passes the cap, without reading the rest", async () => {
    const { req, pulls } = chunked(10 * 1024 * 1024);
    await expect(readCapped(req, 8 * 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulls()).toBeLessThan(20); // stopped after ~9 chunks of 1 KB, not 10,240
  });

  it("refuses at once when the declared Content-Length is over the cap", async () => {
    const req = new Request("http://localhost/x", {
      method: "POST",
      body: "x".repeat(10),
      headers: { "content-length": String(10_000_000) },
    });
    await expect(readCapped(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("returns a body within the cap intact", async () => {
    const req = new Request("http://localhost/x", { method: "POST", body: enc.encode("hello") });
    expect(await readCappedText(req, 100)).toBe("hello");
  });
});

describe("client IP", () => {
  it("prefers the platform edge header, then the first X-Forwarded-For hop", () => {
    expect(
      clientIp(new Headers({ "fly-client-ip": "198.51.100.4", "x-forwarded-for": "1.1.1.1" })),
    ).toBe("198.51.100.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe(
      "203.0.113.9",
    );
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("repeated 401s block the IP", () => {
  it(`refuses an IP after ${AUTH_FAILURE_BLOCK.limit} auth failures, and only that IP`, async () => {
    const ip = `test-${randomUUID()}`;
    const other = `test-${randomUUID()}`;
    for (let i = 0; i < AUTH_FAILURE_BLOCK.limit; i++) {
      expect(await guardAuthFailures(ip)).toBeNull();
      await noteAuthFailure(ip);
    }
    const refused = await guardAuthFailures(ip);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await guardAuthFailures(other)).toBeNull();
  });
});

describe("endpoint limits", () => {
  it("refuses after the limit with 429 and Retry-After", async () => {
    const key = `test:${randomUUID()}`;
    for (let i = 0; i < 3; i++)
      expect(await limitOrRefuse(key, { limit: 3, windowSeconds: 60 })).toBeNull();
    const r = await limitOrRefuse(key, { limit: 3, windowSeconds: 60 });
    expect(r?.status).toBe(429);
  });
});
