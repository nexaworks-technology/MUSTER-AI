import type { ContactStatus, LifecycleStage, SuppressionReason } from "@prisma/client";

/**
 * The auto-send guards (ARCHITECTURE §7.4, spec §6J4 = guards 1–6, plus suppression and the kill
 * switch). Pure: dispatch loads the facts, this decides. Every guard is always evaluated and
 * recorded, so a held message says exactly which guards stopped it. Built test-first.
 */
export const GUARDS = [
  "contact_recently_emailed",
  "account_recently_emailed",
  "quiet_hours",
  "serious_ticket_open",
  "account_lost",
  "sensitive_topic",
  "suppressed",
  "auto_send_disabled",
] as const;
export type GuardName = (typeof GUARDS)[number];

/** What a campaign send must still pass (it is approved once, then sent to many people). */
const CAMPAIGN_GUARDS: readonly GuardName[] = [
  "contact_recently_emailed",
  "quiet_hours",
  "serious_ticket_open",
  "account_lost",
  "suppressed",
];
/** What an approved survey send must still pass. */
const SURVEY_GUARDS: readonly GuardName[] = [
  "contact_recently_emailed",
  "account_recently_emailed",
  "quiet_hours",
  "serious_ticket_open",
  "account_lost",
  "suppressed",
];

/**
 * The guards that stop this send. A person-approved email is stopped only by suppression (and the
 * pre-checks); the other guards apply to automatic sends and are recorded for information. The one
 * rule dispatch applies and the Approvals page labels with (DEMO-WALKTHROUGH note: a human send
 * listed "Not passed: quiet hours" beside "sent").
 */
export function gatingGuards(m: {
  sendMode: string;
  sourceKey: string | null;
}): readonly GuardName[] {
  if (m.sendMode === "APPROVED")
    return m.sourceKey?.startsWith("survey:") ? SURVEY_GUARDS : ["suppressed"];
  if (m.sendMode === "CAMPAIGN") return CAMPAIGN_GUARDS;
  return GUARDS;
}

/** Whether a recorded check stopped (or would stop) this send; a pre-check always does. */
export function checkGates(guard: string, gating: readonly GuardName[]): boolean {
  return !(GUARDS as readonly string[]).includes(guard) || gating.includes(guard as GuardName);
}

export interface GuardResult {
  guard: GuardName;
  passed: boolean;
  detail: string;
}

export interface GuardContext {
  now: Date;
  contact: { email: string | null; timezone: string | null; status: ContactStatus };
  account: { timezone: string | null; lifecycleStage: LifecycleStage };
  lastSentToContactAt: Date | null;
  /** The latest other customer send to this account (another play, a campaign, another draft). */
  lastOtherSendToAccountAt: Date | null;
  openSeriousTicketIds: string[];
  sensitive: { isSensitive: boolean; reasons: string[] };
  suppression: { reason: SuppressionReason } | null;
  autoSendEnabled: boolean;
  quiet: { startHour: number; endHour: number; weekends: boolean };
  contactCooldownHours: number;
  otherPlayCooldownHours: number;
}

const HOUR = 3_600_000;

function validZone(tz: string | null): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function localClock(now: Date, tz: string): { hour: number; weekday: string; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    hour: Number(get("hour")),
    weekday: get("weekday"),
    label: `${get("weekday")} ${get("hour")}:${get("minute")}`,
  };
}

const ago = (now: Date, then: Date) => Math.round(((+now - +then) / HOUR) * 10) / 10;

export function evaluateGuards(c: GuardContext): GuardResult[] {
  const r = (guard: GuardName, passed: boolean, detail: string): GuardResult => ({
    guard,
    passed,
    detail,
  });

  const contactGap = c.lastSentToContactAt ? +c.now - +c.lastSentToContactAt : null;
  const accountGap = c.lastOtherSendToAccountAt ? +c.now - +c.lastOtherSendToAccountAt : null;

  // Contact zone → account zone. A zone that is set but not a real zone counts as unknown (hold):
  // falling through to the next zone would guess which one the customer meant.
  const tz = c.contact.timezone
    ? validZone(c.contact.timezone)
    : c.account.timezone
      ? validZone(c.account.timezone)
      : null;
  let quiet: GuardResult;
  if (!tz) {
    quiet = r(
      "quiet_hours",
      false,
      "The customer's time zone is unknown, so it is held for approval.",
    );
  } else {
    const local = localClock(c.now, tz);
    const { startHour: s, endHour: e } = c.quiet;
    const inQuiet = s > e ? local.hour >= s || local.hour < e : local.hour >= s && local.hour < e;
    const weekend = c.quiet.weekends && (local.weekday === "Sat" || local.weekday === "Sun");
    quiet = r(
      "quiet_hours",
      !inQuiet && !weekend,
      `It is ${local.label} in ${tz}; quiet hours are ${s}:00–${e}:00${c.quiet.weekends ? " and weekends" : ""}.`,
    );
  }

  const unreachable = !c.contact.email
    ? "The contact has no email address."
    : c.suppression
      ? `The address is on the suppression list (${c.suppression.reason.toLowerCase()}).`
      : c.contact.status === "BOUNCED"
        ? "The contact's email bounced."
        : c.contact.status === "LEFT"
          ? "The contact has left the company."
          : null;

  return [
    r(
      "contact_recently_emailed",
      contactGap === null || contactGap >= c.contactCooldownHours * HOUR,
      contactGap === null
        ? "This contact has not been emailed before."
        : `This contact was emailed ${ago(c.now, c.lastSentToContactAt!)} hours ago (limit ${c.contactCooldownHours}).`,
    ),
    r(
      "account_recently_emailed",
      accountGap === null || accountGap >= c.otherPlayCooldownHours * HOUR,
      accountGap === null
        ? "Nothing else emailed this account recently."
        : `Another send reached this account ${ago(c.now, c.lastOtherSendToAccountAt!)} hours ago (limit ${c.otherPlayCooldownHours}).`,
    ),
    quiet,
    r(
      "serious_ticket_open",
      c.openSeriousTicketIds.length === 0,
      c.openSeriousTicketIds.length === 0
        ? "No high, urgent or escalated ticket is open."
        : `${c.openSeriousTicketIds.length} high, urgent or escalated ticket(s) are open.`,
    ),
    r(
      "account_lost",
      c.account.lifecycleStage !== "LOST",
      c.account.lifecycleStage === "LOST"
        ? "The account is lost: never auto-send."
        : "The account is not lost.",
    ),
    r(
      "sensitive_topic",
      !c.sensitive.isSensitive,
      c.sensitive.isSensitive
        ? `Sensitive (${c.sensitive.reasons.join(", ")}): always a human, never auto.`
        : "No sensitive topic found.",
    ),
    r("suppressed", unreachable === null, unreachable ?? "The address may receive email."),
    r(
      "auto_send_disabled",
      c.autoSendEnabled,
      c.autoSendEnabled ? "Auto-send is enabled." : "Auto-send is switched off for this workspace.",
    ),
  ];
}

export const allPassed = (results: GuardResult[]) => results.every((g) => g.passed);
