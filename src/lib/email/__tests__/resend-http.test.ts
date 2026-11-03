import { describe, expect, it } from "vitest";
import { postResendEmail } from "../resendHttp";

/**
 * The Resend path with a fake fetch (founder clarification B): nothing leaves the machine. Live
 * Resend verification is deferred (M12, or earlier if a key is provided).
 */
describe("postResendEmail", () => {
  it("posts one message with the key in the header and an idempotency key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "re_123" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await postResendEmail(
      "test-key",
      {
        from: "csm@x.test",
        to: "maya@b.test",
        subject: "Hi",
        text: "Body",
        idempotencyKey: "om_1",
      },
      fakeFetch,
    );
    expect(r).toEqual({ id: "re_123" });
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["idempotency-key"]).toBe("om_1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: "csm@x.test",
      to: ["maya@b.test"],
      subject: "Hi",
      text: "Body",
    });
  });

  it("a rejected request throws without echoing the key or the body", async () => {
    const fakeFetch = (async () => new Response("no", { status: 422 })) as unknown as typeof fetch;
    const err = await postResendEmail(
      "test-key",
      { from: "a@x.test", to: "b@x.test", subject: "S", text: "secret body", idempotencyKey: "k" },
      fakeFetch,
    ).catch((e: Error) => e);
    expect(String(err)).toContain("HTTP 422");
    expect(String(err)).not.toContain("test-key");
    expect(String(err)).not.toContain("secret body");
  });
});
