import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "@/lib/config/env";
import { scopedDb } from "@/lib/db/scoped";
import { closeRateLimit } from "@/lib/rate-limit";
import { createTestAdmin } from "@/test/fixtures";
import {
  createSurvey,
  dispatchSurvey,
  getSurveyForToken,
  SURVEY_LINK_DAYS,
  submitSurveyResponse,
  verifySurveyToken,
} from "../service";

/**
 * M12 A10 — the M10 survey-intake bug and its attack pass (test-first). M10's PASS was
 * service-level only: the emailed link pointed at a hard-coded https://app.nexaworks.com path
 * that never existed, the token never expired, its signature was compared with `!==`, and its
 * payload was not validated. Now: the link is APP_URL/s/<token>; tokens expire after
 * SURVEY_LINK_DAYS; a tampered, expired, malformed or foreign token is refused; one answer per
 * token; the public page reads the survey through the token only.
 */
// A fresh documentation-range IP per run: rate-limit windows in Redis outlive a run.
let currentIp = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": currentIp }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

let actor: Awaited<ReturnType<typeof createTestAdmin>>["actor"];
let token: string;
let body: string;

beforeAll(async () => {
  ({ actor } = await createTestAdmin("SurveyLink"));
  const db = scopedDb(actor);
  const account = await db.account.create({ data: { workspaceId: actor.workspaceId, name: "S Co", tier: "MID_TOUCH" } });
  const contact = await db.contact.create({
    data: { workspaceId: actor.workspaceId, accountId: account.id, name: "Sam", email: `sam-${randomUUID().slice(0, 6)}@s.example` },
  });
  const survey = await createSurvey(actor, { type: "NPS", trigger: "MANUAL", question: "How likely are you to recommend us?" });
  const res = await dispatchSurvey(actor, { surveyId: survey.id, accountId: account.id, contactId: contact.id });
  token = res.token;
  const msg = await db.outboundMessage.findFirstOrThrow({ where: { approvalId: res.approval.id } });
  body = msg.bodyText;
});
afterAll(async () => {
  await closeRateLimit();
});

describe("survey link (M10 bug fixed in M12)", () => {
  it("the emailed link is APP_URL/s/<token>, never a hard-coded host", () => {
    expect(body).toContain(`${env().APP_URL}/s/${token}`);
    expect(body).not.toContain("app.nexaworks.com");
  });

  it("a valid token opens the survey through the token only", async () => {
    const view = await getSurveyForToken(token);
    expect(view).toMatchObject({ question: "How likely are you to recommend us?", type: "NPS", answered: false });
  });

  it("a tampered signature of the same length is refused", () => {
    const [data, sig] = token.split(".");
    // A middle character: base64url's last character carries 2 padding bits that decoding
    // ignores, so changing only it can leave the signature bytes intact (flaked ~1 run in 16).
    const i = Math.floor(sig!.length / 2);
    const flipped = `${sig!.slice(0, i)}${sig![i] === "A" ? "B" : "A"}${sig!.slice(i + 1)}`;
    expect(() => verifySurveyToken(`${data}.${flipped}`)).toThrow(/invalid/i);
  });

  it(`a token older than ${SURVEY_LINK_DAYS} days is refused`, () => {
    const later = Date.now() + (SURVEY_LINK_DAYS + 1) * 86_400_000;
    expect(() => verifySurveyToken(token, later)).toThrow(/expired/i);
  });

  it("a payload that is not a survey token is refused even with a valid-looking signature", () => {
    // Signed with a guessed key (the old code path signed with the raw secret, no domain separation).
    const data = Buffer.from(JSON.stringify({ hello: "world" })).toString("base64url");
    const sig = createHmac("sha256", process.env.AUTH_SECRET ?? "x").update(data).digest("base64url");
    expect(() => verifySurveyToken(`${data}.${sig}`)).toThrow(/invalid/i);
  });

  it("garbage is refused without throwing anything but an invalid-token error", () => {
    for (const t of ["", "a", "a.b.c", "!!!.???", "x".repeat(5000)]) expect(() => verifySurveyToken(t)).toThrow(/invalid/i);
  });

  it("answers once: the public submit records the score; a second submit is refused", async () => {
    const { submitSurveyFormAction } = await import("@/app/s/[token]/actions");
    const fd = new FormData();
    fd.set("token", token);
    fd.set("score", "9");
    expect(await submitSurveyFormAction({}, fd)).toEqual({ ok: true });
    expect((await submitSurveyFormAction({}, fd)).error).toMatch(/already/i);
    expect((await getSurveyForToken(token))?.answered).toBe(true);
    await expect(submitSurveyResponse({ token, score: 3 })).rejects.toThrow(/already/i);
  });

  it("an out-of-range score is refused", async () => {
    const { submitSurveyFormAction } = await import("@/app/s/[token]/actions");
    const fd = new FormData();
    fd.set("token", token);
    fd.set("score", "11");
    expect((await submitSurveyFormAction({}, fd)).error).toBeTruthy();
  });

  it("the public submit is limited per IP and bad tokens count against the IP", async () => {
    const { submitSurveyFormAction } = await import("@/app/s/[token]/actions");
    currentIp = `198.18.9.${Math.floor(Math.random() * 250)}`;
    const fd = new FormData();
    fd.set("token", "bad.token");
    fd.set("score", "5");
    let refused = false;
    for (let i = 0; i < 25 && !refused; i++)
      refused = /too many attempts/i.test((await submitSurveyFormAction({}, fd)).error ?? "");
    expect(refused).toBe(true);
  });
});
