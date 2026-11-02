import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { utcMidnight, type CalendarDate } from "@/lib/dates";
import { writeOutboxEvent } from "@/lib/jobs/outbox";
import { OUTSIDE_KIND_WORDS, OUTSIDE_KINDS, OUTSIDE_POLARITY } from "./schemas";

/**
 * Outside signals (INTERP-6): public news about the customer's company, always with a public
 * source link and its date (Zod here, a CHECK in the database). Entered by people or by CSV;
 * never raised by an evaluator and never resolved by one.
 */
export function outsideInputFor(today: CalendarDate) {
  return z.object({
    accountId: z.string().min(1),
    kind: z.enum(OUTSIDE_KINDS),
    headline: z.string().trim().min(3, "Add a short headline").max(200),
    sourceUrl: z
      .string()
      .trim()
      .min(1, "A public source link is required")
      .url("Use a full web address (https://…)")
      .refine(
        (u) => /^https?:\/\//i.test(u),
        "Use a web address that starts with http:// or https://",
      ),
    eventDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "The event date is required (YYYY-MM-DD)")
      .refine((d) => d <= today, "The event date cannot be in the future"),
  });
}
export type OutsideInput = z.infer<ReturnType<typeof outsideInputFor>>;

export const outsideDedupeKey = (i: Pick<OutsideInput, "accountId" | "sourceUrl" | "eventDate">) =>
  `outside_event:${i.accountId}:${createHash("sha256").update(i.sourceUrl).digest("hex").slice(0, 16)}:${i.eventDate}`;

/**
 * Inserts the signal (or returns the one already recorded for this source and date), its outcome
 * record and the signal.opened event, inside the caller's transaction.
 */
export async function insertOutsideSignal(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  input: OutsideInput,
  o: {
    origin: "HUMAN" | "IMPORT";
    createdByMembershipId: string;
    today: CalendarDate;
    now: Date;
    ruleVersion: number;
  },
) {
  const dedupeKey = outsideDedupeKey(input);
  const existing = await tx.signal.findFirst({
    where: { dedupeKey },
    orderBy: { episode: "desc" },
  });
  if (existing) return { signal: existing, created: false };
  const account = await tx.account.findUniqueOrThrow({
    where: { id: input.accountId },
    select: { arrMinor: true, arrCurrency: true },
  });
  const polarity = OUTSIDE_POLARITY[input.kind];
  const signal = await tx.signal.create({
    data: {
      workspaceId,
      accountId: input.accountId,
      ruleKey: "outside_event",
      ruleVersion: o.ruleVersion,
      category: "OUTSIDE",
      severity: "WARN",
      polarity,
      title: `${OUTSIDE_KIND_WORDS[input.kind]}: ${input.headline}`,
      explanation: `${input.headline}. From a public source dated ${input.eventDate}.`,
      evidence: [{ sourceType: "PublicSource", value: input.sourceUrl, date: input.eventDate }],
      values: { kind: input.kind, eventDate: input.eventDate },
      params: {},
      dedupeKey,
      episode: 1,
      firstSeenAt: utcMidnight(o.today),
      lastSeenAt: utcMidnight(o.today),
      origin: o.origin,
      publicSourceUrl: input.sourceUrl,
      publicSourceDate: utcMidnight(input.eventDate),
      createdByMembershipId: o.createdByMembershipId,
    },
  });
  await tx.outcomeRecord.create({
    data: {
      workspaceId,
      accountId: input.accountId,
      signalId: signal.id,
      flagType: polarity,
      flaggedAt: o.now,
      arrAtFlagMinor: account.arrMinor,
      arrCurrency: account.arrMinor !== null ? account.arrCurrency : null,
    },
  });
  await writeOutboxEvent(tx, {
    workspaceId,
    type: "signal.opened",
    payload: {
      signalId: signal.id,
      accountId: input.accountId,
      ruleKey: "outside_event",
      severity: "WARN",
      episode: 1,
    },
  });
  return { signal, created: true };
}
