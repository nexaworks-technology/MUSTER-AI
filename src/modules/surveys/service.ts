import crypto from "node:crypto";
import { z } from "zod";
import type { SurveyStatus, SurveyTrigger, SurveyType } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { businessClock, type Clock } from "@/lib/dates";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { requestApproval } from "@/modules/approvals/lifecycle";
import { computeSurveyMetrics, type SurveyMetricsResult } from "./metrics";

const SECRET = process.env.APP_SECRET ?? process.env.NEXTAUTH_SECRET ?? "$REMOVED_SURVEY_FALLBACK";

export interface SurveyTokenPayload {
  workspaceId: string;
  surveyId: string;
  accountId: string;
  contactId: string | null;
  issuedAt: number;
}

export function createSurveyToken(payload: Omit<SurveyTokenPayload, "issuedAt">): string {
  const full: SurveyTokenPayload = { ...payload, issuedAt: Date.now() };
  const json = JSON.stringify(full);
  const data = Buffer.from(json).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifySurveyToken(token: string): SurveyTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid survey token format.");
  const [data, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", SECRET).update(data!).digest("base64url");
  if (sig !== expectedSig) throw new Error("Invalid survey token signature.");
  try {
    const json = Buffer.from(data!, "base64url").toString("utf8");
    return JSON.parse(json) as SurveyTokenPayload;
  } catch {
    throw new Error("Invalid survey token payload.");
  }
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

export async function getSurveyMetrics(actor: Actor, surveyId: string): Promise<SurveyMetricsResult> {
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

  const portalSurveyUrl = `https://app.nexaworks.com/portal/surveys?token=${token}`;
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
  const payload = verifySurveyToken(input.token);
  const now = (opts.clock ?? businessClock)();

  return rawDb.$transaction(async (tx) => {
    // Set RLS tenant and token variables
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.workspace_id', $1, true), set_config('app.survey_token', $2, true)`,
      payload.workspaceId,
      input.token,
    );

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
