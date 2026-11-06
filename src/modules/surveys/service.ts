import crypto from "node:crypto";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/config/env";
import { businessClock, type Clock } from "@/lib/dates";
import { withSurveyTokenSession } from "@/lib/db/token-access";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { requestApproval } from "@/modules/approvals/service";
import { computeSurveyMetrics, type SurveyMetricsResult } from "./metrics";

/**
 * Survey links (M10, hardened in M12 A10). The signing key comes from env only (Rule 9) and is
 * domain-separated for this one purpose, so a token signed for anything else never verifies here.
 */
function surveyKey(): Buffer {
  const secret = process.env.APP_SECRET ?? process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) throw new Error("Survey links need APP_SECRET, NEXTAUTH_SECRET or AUTH_SECRET");
  return crypto.createHmac("sha256", secret).update("nexaworks:survey-link:v2").digest();
}

/** How long an emailed survey link stays valid (M12 A10). */
export const SURVEY_LINK_DAYS = 30;

const surveyTokenPayload = z.object({
  v: z.literal(2),
  workspaceId: z.string().min(1).max(64),
  surveyId: z.string().min(1).max(64),
  accountId: z.string().min(1).max(64),
  contactId: z.string().min(1).max(64).nullable(),
  issuedAt: z.number().int().positive(),
  exp: z.number().int().positive(),
});
export type SurveyTokenPayload = z.infer<typeof surveyTokenPayload>;

export class SurveyTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurveyTokenError";
  }
}

const sign = (data: string) => crypto.createHmac("sha256", surveyKey()).update(data).digest();

export function createSurveyToken(
  payload: Pick<SurveyTokenPayload, "workspaceId" | "surveyId" | "accountId" | "contactId">,
  now: number = Date.now(),
): string {
  const full: SurveyTokenPayload = {
    v: 2,
    ...payload,
    issuedAt: now,
    exp: now + SURVEY_LINK_DAYS * 86_400_000,
  };
  const data = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${data}.${sign(data).toString("base64url")}`;
}

/** Verifies signature (constant time), payload shape (Zod) and expiry; any failure is "invalid". */
export function verifySurveyToken(token: string, now: number = Date.now()): SurveyTokenPayload {
  if (typeof token !== "string" || token.length > 4096)
    throw new SurveyTokenError("Invalid survey link.");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new SurveyTokenError("Invalid survey link.");
  const [data, sig] = parts as [string, string];
  const want = sign(data);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want))
    throw new SurveyTokenError("Invalid survey link.");
  let parsed: SurveyTokenPayload;
  try {
    parsed = surveyTokenPayload.parse(JSON.parse(Buffer.from(data, "base64url").toString("utf8")));
  } catch {
    throw new SurveyTokenError("Invalid survey link.");
  }
  if (parsed.exp <= now) throw new SurveyTokenError("This survey link has expired.");
  return parsed;
}

/** The public survey page's view, read through the token only (M12 A10). Null when invalid. */
export async function getSurveyForToken(token: string, now: number = Date.now()) {
  let payload: SurveyTokenPayload;
  try {
    payload = verifySurveyToken(token, now);
  } catch {
    return null;
  }
  return withSurveyTokenSession(payload.workspaceId, token, async (tx) => {
    const survey = await tx.survey.findFirst({
      where: { id: payload.surveyId, workspaceId: payload.workspaceId, status: "ACTIVE" },
      select: { question: true, type: true },
    });
    if (!survey) return null;
    const answered =
      (await tx.surveyResponse.count({ where: { workspaceId: payload.workspaceId, token } })) > 0;
    return { question: survey.question, type: survey.type, answered };
  });
}

export const createSurveySchema = z.object({
  type: z.enum(["NPS", "CSAT", "CES"]),
  trigger: z.enum(["ONBOARDING_VALUE_REACHED", "TICKET_CLOSED", "RENEWAL_WINDOW_60", "MANUAL"]),
  question: z.string().trim().min(3).max(500),
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).default("ACTIVE"),
});
export type CreateSurveyInput = z.input<typeof createSurveySchema>;

export async function createSurvey(actor: Actor, raw: CreateSurveyInput) {
  const input = createSurveySchema.parse(raw);
  const db = scopedDb(actor);
  const survey = await db.survey.create({
    data: {
      workspaceId: actor.workspaceId,
      type: input.type,
      trigger: input.trigger,
      question: input.question,
      status: input.status,
    },
  });
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "survey.created",
    targetType: "Survey",
    targetId: survey.id,
    summary: `Created ${input.type} survey for ${input.trigger}`,
  });
  return survey;
}

export async function listSurveys(actor: Actor) {
  const db = scopedDb(actor);
  return db.survey.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { responses: true } },
    },
  });
}

export async function getSurvey(actor: Actor, surveyId: string) {
  const db = scopedDb(actor);
  return db.survey.findUniqueOrThrow({
    where: { id: surveyId },
    include: {
      _count: { select: { responses: true } },
    },
  });
}

export async function getSurveyMetrics(
  actor: Actor,
  surveyId: string,
): Promise<SurveyMetricsResult> {
  const db = scopedDb(actor);
  const survey = await db.survey.findUniqueOrThrow({
    where: { id: surveyId },
    include: {
      responses: { select: { score: true } },
    },
  });
  return computeSurveyMetrics(survey.type, survey.responses);
}

export const dispatchSurveySchema = z.object({
  surveyId: z.string().min(1),
  accountId: z.string().min(1),
  contactId: z.string().min(1),
  sourceKey: z.string().optional(),
});
export type DispatchSurveyInput = z.input<typeof dispatchSurveySchema>;

export async function dispatchSurvey(
  actor: Actor,
  raw: DispatchSurveyInput,
  opts: { clock?: Clock } = {},
) {
  const input = dispatchSurveySchema.parse(raw);
  const db = scopedDb(actor);
  const now = (opts.clock ?? businessClock)();
  const [survey, account, contact] = await Promise.all([
    db.survey.findUniqueOrThrow({ where: { id: input.surveyId } }),
    db.account.findUniqueOrThrow({ where: { id: input.accountId } }),
    db.contact.findUniqueOrThrow({ where: { id: input.contactId } }),
  ]);

  if (!contact.email) {
    throw new Error("Contact has no email address.");
  }

  const token = createSurveyToken({
    workspaceId: actor.workspaceId,
    surveyId: survey.id,
    accountId: account.id,
    contactId: contact.id,
  });

  // M12 A10 (M10 bug): the link is this deployment's public survey page, not a hard-coded host.
  const portalSurveyUrl = `${env().APP_URL}/s/${token}`;
  const subject = `Feedback request: ${survey.question}`;
  const body = `Hi ${contact.name},\n\nWe would love your feedback: ${survey.question}\n\nPlease share your rating here:\n${portalSurveyUrl}\n\nThank you,\n${account.name} Team`;

  const dateStr = now.toISOString().slice(0, 10);
  const sourceKey = input.sourceKey ?? `survey:${survey.id}:${contact.id}:${dateStr}`;

  const approval = await requestApproval(
    actor,
    {
      accountId: account.id,
      kind: "SEND_EMAIL",
      reason: `Survey: ${survey.type} feedback triggered by ${survey.trigger}`,
      proof: [
        { sourceType: "Survey", sourceId: survey.id },
        { sourceType: "Account", sourceId: account.id },
      ],
      sourceKey,
      email: {
        contactId: contact.id,
        subject,
        body,
        origin: "HUMAN",
      },
    },
    { clock: opts.clock },
  );

  return { approval, token, url: portalSurveyUrl };
}

export const submitResponseSchema = z.object({
  token: z.string().min(1),
  score: z.number().int(),
  comment: z.string().trim().max(2000).optional(),
});
export type SubmitResponseInput = z.input<typeof submitResponseSchema>;

export async function submitSurveyResponse(raw: SubmitResponseInput, opts: { clock?: Clock } = {}) {
  const input = submitResponseSchema.parse(raw);
  const now = (opts.clock ?? businessClock)();
  const payload = verifySurveyToken(input.token);

  // RLS tenant and survey-token settings are set by the helper (src/lib/db/token-access.ts).
  return withSurveyTokenSession(payload.workspaceId, input.token, async (tx) => {
    // Validate score bounds against survey type
    const survey = await tx.survey.findUniqueOrThrow({
      where: { id: payload.surveyId },
      select: { type: true },
    });

    if (survey.type === "NPS" && (input.score < 0 || input.score > 10)) {
      throw new Error("NPS score must be between 0 and 10.");
    }
    if (survey.type === "CSAT" && (input.score < 1 || input.score > 5)) {
      throw new Error("CSAT score must be between 1 and 5.");
    }
    if (survey.type === "CES" && (input.score < 1 || input.score > 7)) {
      throw new Error("CES score must be between 1 and 7.");
    }

    const existing = await tx.surveyResponse.findFirst({
      where: { workspaceId: payload.workspaceId, token: input.token },
    });
    if (existing) {
      throw new Error("This survey has already been submitted.");
    }

    const response = await tx.surveyResponse.create({
      data: {
        workspaceId: payload.workspaceId,
        surveyId: payload.surveyId,
        accountId: payload.accountId,
        contactId: payload.contactId,
        score: input.score,
        comment: input.comment ?? null,
        token: input.token,
        respondedAt: now,
      },
    });

    await writeAudit(
      {
        workspaceId: payload.workspaceId,
        actorType: "PORTAL_CONTACT",
        actorId: payload.contactId ?? "ANONYMOUS",
        action: "survey.response_received",
        targetType: "SurveyResponse",
        targetId: response.id,
        summary: `Survey response received (score: ${input.score})`,
        after: { score: input.score, comment: input.comment },
      },
      tx,
    );

    return response;
  });
}
