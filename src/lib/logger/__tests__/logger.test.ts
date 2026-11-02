import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { REDACT_PATHS } from "../index";

describe("logger redaction (Rule 9)", () => {
  it("censors secrets, tokens and message bodies", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, sink);
    log.info({
      password: "p1",
      user: { passwordHash: "p2", id: "u1" },
      session: { sessionToken: "t1" },
      headers: { authorization: "Bearer t2", cookie: "c1" },
      account: { refresh_token: "t3" },
      message: { bodyText: "customer wrote this" },
    });
    const out = lines.join("");
    for (const secret of ["p1", "p2", "t1", "t2", "c1", "t3", "customer wrote this"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('"id":"u1"');
  });
});
