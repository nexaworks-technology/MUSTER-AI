import { describe, expect, it, vi } from "vitest";
import { buildEvent, captureError, captureErrorWith, parseDsn } from "../error-tracking";

/** M12 B4 — Q-20 / Rule 8: the tracker gets the error's shape, never its content. */
const DSN = "https://publickey123@errors.example.com/42";

function fixtureError() {
  const e = new Error("Invoice for jane.doe@customer.com failed: $12,345.67 owed by Acme");
  e.name = "BillingError";
  return e;
}

describe("parseDsn", () => {
  it("derives the store endpoint and key, and rejects junk without throwing", () => {
    const parsed = parseDsn(DSN);
    expect(parsed?.endpoint).toBe("https://errors.example.com/api/42/store/");
    expect(parsed?.publicKey).toBe("publickey123");
    expect(parseDsn("not a url")).toBeNull();
    expect(parseDsn("ftp://k@h/1")).toBeNull();
    expect(parseDsn("https://h/1")).toBeNull();
  });
});

describe("buildEvent", () => {
  it("carries type, frames, ids, environment and release only", () => {
    const event = JSON.stringify(
      buildEvent(
        fixtureError(),
        { requestId: "req-12345678", route: "/api/files" },
        {
          environment: "production",
          release: "abc123",
        },
      ),
    );
    expect(event).toContain("BillingError");
    expect(event).toContain("req-12345678");
    expect(event).toContain("/api/files");
    expect(event).toContain("production");
    expect(event).toContain("abc123");
    expect(event).toContain("error-tracking.test"); // a stack frame file
    expect(event).not.toContain("jane.doe@customer.com");
    expect(event).not.toContain("12,345.67");
    expect(event).not.toContain("Invoice for");
    expect(event).not.toMatch(/[\w.]+@[\w.]+\.\w+/);
    expect(event).not.toContain('"message"');
  });
});

describe("captureErrorWith", () => {
  it("sends nothing without a DSN", async () => {
    const fetchFn = vi.fn();
    await captureErrorWith(fixtureError(), { jobId: "j1" }, { dsn: undefined, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts exactly one scrubbed event with a DSN, and never throws", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await captureErrorWith(
      fixtureError(),
      { jobId: "j-9", queue: "sync", job: "sync.run" },
      { dsn: DSN, fetchFn, environment: "test" },
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://errors.example.com/api/42/store/");
    const body = String(init.body);
    expect(body).toContain("j-9");
    expect(body).toContain("sync.run");
    expect(body).not.toContain("jane.doe@customer.com");
    expect(body).not.toContain("12,345.67");
    expect(JSON.stringify(init.headers)).not.toContain("jane.doe");

    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      captureErrorWith(fixtureError(), {}, { dsn: DSN, fetchFn: failing }),
    ).resolves.toBeUndefined();
  });

  it("captureError is a no-op when the environment has no DSN", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await captureError(fixtureError(), { jobId: "j1" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
