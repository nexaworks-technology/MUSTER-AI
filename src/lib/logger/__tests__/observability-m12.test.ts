import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLogger, jobLogger, runWithJobContext } from "../index";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/observability/request-id";

/** M12 B4 — structured logs carry a request id / job id and never carry secrets or addresses. */
function capture() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, log: createLogger(sink) };
}

describe("log redaction", () => {
  it("censors auth headers, tokens, passwords, keys, secrets and email addresses", () => {
    const { lines, log } = capture();
    log.info(
      {
        req: { headers: { authorization: "Bearer abc123token", cookie: "session=cookie-value-1" } },
        headers: { "set-cookie": "sid=cookie-value-2", "x-api-key": "key-value-3" },
        user: { password: "hunter2-pw", email: "ada@example.com" },
        body: { text: "please reply to bob@example.com" },
        env: { RESEND_API_KEY: "re_live_abcdef123456", ERROR_TRACKING_DSN: "https://k@h/1" },
        integration: { secret: "whsec_topsecret", access_token: "at-value" },
        note: "contact carol@example.org about it",
      },
      "hello dave@example.net",
    );
    const out = lines.join("");
    for (const leaked of [
      "abc123token",
      "cookie-value-1",
      "cookie-value-2",
      "key-value-3",
      "hunter2-pw",
      "ada@example.com",
      "bob@example.com",
      "re_live_abcdef123456",
      "https://k@h/1",
      "whsec_topsecret",
      "at-value",
      "carol@example.org",
      "dave@example.net",
    ])
      expect(out, leaked).not.toContain(leaked);
  });
});

describe("request id", () => {
  it("accepts a well-formed inbound id and replaces anything else", () => {
    expect(resolveRequestId("abcd1234-ef56")).toBe("abcd1234-ef56");
    for (const bad of [
      null,
      undefined,
      "",
      "short",
      "has space in it",
      "x".repeat(65),
      "a\nb12345678",
      "<script>12345",
    ])
      expect(resolveRequestId(bad)).toMatch(/^[0-9a-f-]{36}$/);
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });

  it("flows from the request header into the log line", async () => {
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-request-id": "req-12345678" }),
    }));
    vi.doMock("server-only", () => ({}));
    const { requestLogger } = await import("../request");
    const { lines, log } = capture();
    const child = await requestLogger({ route: "/api/x" }, log);
    child.info({ accountId: "a1" }, "did a thing");
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ requestId: "req-12345678", route: "/api/x", accountId: "a1" });
    vi.doUnmock("next/headers");
  });
});

describe("job context", () => {
  it("puts jobId, queue and job on every line, including plain logger calls inside the job", async () => {
    const { lines, log } = capture();
    const ctx = { jobId: "j-1", queue: "signals", job: "nightly.kickoff" };
    await runWithJobContext(ctx, async () => {
      log.info("from the root logger");
      jobLogger(ctx, log).warn("from the job logger");
    });
    log.info("outside any job");
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject(ctx);
    expect(parsed[1]).toMatchObject(ctx);
    expect(parsed[2]).not.toHaveProperty("jobId");
  });
});
