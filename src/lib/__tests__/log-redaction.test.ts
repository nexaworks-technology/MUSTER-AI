import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "@/lib/logger";

// M12 A11 (Rule 9 / Rule 8): nothing secret, no email body and no AI content reaches a log line.
// Marker values are unique strings; the assertion is that none of them appears in the output.

function capture() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const log = createLogger(sink);
  return { log, out: () => lines.join("") };
}

const SECRETS = {
  session: "SEC-session-token-aaa111",
  creds: "SEC-credentialsEnc-bbb222",
  access: "SEC-accessToken-ccc333",
  refresh: "SEC-refreshToken-ddd444",
  apiKey: ["sk-ant-", "api03-SEC-eee555-", "Z".repeat(16)].join(""),
  password: "SEC-password-fff666",
  bodyText: "SEC-bodyText-ggg777 dear customer",
  body: "SEC-body-hhh888",
  output: "SEC-ai-output-iii999",
  answer: "SEC-ai-answer-jjj000",
  prompt: "SEC-ai-prompt-kkk111",
  system: "SEC-ai-system-lll222",
  input: "SEC-ai-input-mmm333",
  auth: "Bearer SEC-authz-nnn444",
  cookie: "SEC-cookie-ooo555",
  setCookie: "SEC-setcookie-ppp666",
};

describe("log redaction (M12 A11)", () => {
  it("redacts top-level fields", () => {
    const { log, out } = capture();
    log.info({
      sessionToken: SECRETS.session,
      credentialsEnc: SECRETS.creds,
      accessToken: SECRETS.access,
      refreshToken: SECRETS.refresh,
      ANTHROPIC_API_KEY: SECRETS.apiKey,
      apiKey: SECRETS.apiKey,
      password: SECRETS.password,
      bodyText: SECRETS.bodyText,
      body: SECRETS.body,
      output: SECRETS.output,
      answer: SECRETS.answer,
      prompt: SECRETS.prompt,
      system: SECRETS.system,
      input: SECRETS.input,
      authorization: SECRETS.auth,
      cookie: SECRETS.cookie,
      id: "keep-me",
    });
    for (const v of Object.values(SECRETS)) expect(out()).not.toContain(v);
    expect(out()).toContain("keep-me");
  });

  it("redacts nested fields at several depths", () => {
    const { log, out } = capture();
    log.error({
      req: {
        headers: {
          authorization: SECRETS.auth,
          cookie: SECRETS.cookie,
          "set-cookie": SECRETS.setCookie,
        },
      },
      integration: {
        credentialsEnc: SECRETS.creds,
        nested: { deep: { accessToken: SECRETS.access, refreshToken: SECRETS.refresh } },
      },
      user: { password: SECRETS.password },
      message: { bodyText: SECRETS.bodyText, body: SECRETS.body },
      run: {
        output: SECRETS.output,
        answer: SECRETS.answer,
        prompt: SECRETS.prompt,
        system: SECRETS.system,
        input: SECRETS.input,
      },
      list: [{ sessionToken: SECRETS.session }, { apiKey: SECRETS.apiKey }],
    });
    for (const v of Object.values(SECRETS)) expect(out()).not.toContain(v);
  });

  it("redacts inside err objects and error causes", () => {
    const { log, out } = capture();
    const cause = Object.assign(new Error("inner"), {
      config: { headers: { authorization: SECRETS.auth } },
    });
    const err = Object.assign(new Error("upstream failed", { cause }), {
      response: { data: { output: SECRETS.output, accessToken: SECRETS.access } },
      request: { headers: { cookie: SECRETS.cookie }, body: SECRETS.body },
      apiKey: SECRETS.apiKey,
    });
    log.error({ err }, "call failed");
    log.error(err);
    const text = out();
    for (const v of [
      SECRETS.output,
      SECRETS.access,
      SECRETS.cookie,
      SECRETS.body,
      SECRETS.apiKey,
      SECRETS.auth,
    ]) {
      expect(text).not.toContain(v);
    }
    expect(text).toContain("upstream failed");
  });

  it("scrubs key-shaped and bearer values that appear inside free-text strings", () => {
    const { log, out } = capture();
    log.warn(`request failed with key ${SECRETS.apiKey} and header ${SECRETS.auth}`);
    log.warn({ detail: `x-api-key: ${SECRETS.apiKey}` }, "again");
    expect(out()).not.toContain("SEC-eee555");
    expect(out()).not.toContain("SEC-authz-nnn444");
  });
});
