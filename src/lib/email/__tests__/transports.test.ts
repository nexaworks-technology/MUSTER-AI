import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogTransport } from "../logTransport";
import { createResendTransport } from "../resendTransport";

const message = { to: "dana@larkspur.test", subject: "You're invited", text: "Join here" };

describe("log transport", () => {
  it("writes the message to a file instead of sending it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mail-"));
    const { id } = await createLogTransport(dir).send(message);
    const [file] = await readdir(dir);
    expect(JSON.parse(await readFile(path.join(dir, file!), "utf8"))).toMatchObject({
      id,
      ...message,
    });
  });
});

describe("resend transport", () => {
  it("posts to the provider with the key in the header, not the body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    );
    const t = createResendTransport("key-from-env", "Larkspur <no-reply@larkspur.test>", fetchImpl);
    expect(await t.send(message)).toEqual({ id: "msg_1" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key-from-env");
    expect(String(init.body)).not.toContain("key-from-env");
  });

  it("surfaces provider errors without the key", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 422 }));
    const t = createResendTransport("key-from-env", "a@b.test", fetchImpl);
    await expect(t.send(message)).rejects.toThrow(/HTTP 422/);
    await expect(t.send(message)).rejects.not.toThrow(/key-from-env/);
  });
});
