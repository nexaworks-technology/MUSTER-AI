import { renewalSettings } from "@/modules/renewals/schemas";
import { z } from "zod";
import { DEFAULT_THEMES, themeSettingSchema } from "@/modules/conversations/schemas";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/constants";

const ROLE = z.enum(["ADMIN", "CS_LEADER", "CSM", "VIEWER"]);
const BOOK_SCOPE = z.enum(["OWN", "TEAM", "ALL"]);
const checkbox = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());

export const ROLE_LABELS = {
  ADMIN: "Admin",
  CS_LEADER: "CS Leader",
  CSM: "CSM",
  VIEWER: "Viewer",
} as const;
export const BOOK_SCOPE_LABELS = {
  OWN: "Own accounts",
  TEAM: "Team",
  ALL: "All accounts",
} as const;

export const inviteInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")),
  role: ROLE,
  canViewRevenue: checkbox,
  bookScope: BOOK_SCOPE.default("OWN"),
});

export const updateMembershipInput = z.object({
  membershipId: z.string().min(1),
  role: ROLE,
  canViewRevenue: checkbox,
  bookScope: BOOK_SCOPE,
});

export const membershipIdInput = z.object({ membershipId: z.string().min(1) });
export const invitationIdInput = z.object({ invitationId: z.string().min(1) });

export const acceptAsNewUserInput = z.object({
  token: z.string().min(20),
  name: z.string().trim().min(1, "Enter your name").max(120),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(512),
});

const TIMEZONES = new Set(Intl.supportedValuesOf("timeZone").concat("UTC"));
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export const workspaceProfileInput = z.object({
  name: z.string().trim().min(1, "Enter a workspace name").max(120),
  timezone: z.string().refine((tz) => TIMEZONES.has(tz), "Choose a time zone from the list"),
  baseCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((c) => CURRENCIES.has(c), "Use a three-letter ISO currency code, e.g. USD"),
});

export const TIMEZONE_OPTIONS = [...TIMEZONES].sort();
export const CURRENCY_OPTIONS = [...CURRENCIES].sort();

/**
 * Typed WorkspaceSettings.data (ARCHITECTURE §3.2). Every field has a default, so a workspace
 * with an empty settings row behaves exactly like the documented defaults.
 * Missing-data snooze defaults to 7 days (founder decision C2, supersedes Q-09's 30 days).
 */
export const workspaceSettingsData = z.object({
  tierRule: z
    .object({
      /** ARR (whole units of the base currency) at or above which an account is high-touch. */
      highTouchMinArr: z.number().int().positive().default(50_000),
      midTouchMinArr: z.number().int().positive().default(10_000),
    })
    .prefault({}),
  missingData: z
    .object({
      snoozeDays: z.number().int().min(1).max(365).default(7),
      maxPromptsPerUserPerDay: z.number().int().min(1).max(20).default(3),
    })
    .prefault({}),
  dataQuality: z
    .object({
      /** An account with no update and no activity for this long is flagged as stale. */
      staleAfterDays: z.number().int().min(30).max(730).default(180),
    })
    .prefault({}),
  tasks: z
    .object({
      /** An open task this many days past its due date escalates to the CS Leaders (§6F3). */
      escalateAfterDays: z.number().int().min(1).max(60).default(1),
    })
    .prefault({}),
  ai: z
    .object({
      /** Tokens (input + output) all agents may use per workspace per calendar day (§6.3). */
      dailyTokenBudget: z.number().int().min(0).default(2_000_000),
    })
    .prefault({}),
  ask: z
    .object({
      /**
       * Q-11: offer the browser's own dictation on the Ask AI box. Off by default; audio is handled
       * by the browser vendor and never reaches our servers.
       */
      voiceDictation: z.boolean().default(false),
    })
    .prefault({}),
  outbound: z
    .object({
      /**
       * The auto-send kill switch (guard 8). Enabled in M8 behind typed Admin confirmation.
       * Human-approved sends do not depend on it.
       */
      autoSendEnabled: z.boolean().default(false),
      /** Quiet hours in the customer's local time: [start, end) wraps midnight (guard 3). */
      quietStartHour: z.number().int().min(0).max(23).default(19),
      quietEndHour: z.number().int().min(0).max(23).default(8),
      quietOnWeekends: z.boolean().default(true),
      contactCooldownHours: z.number().int().min(1).default(72),
      otherPlayCooldownHours: z.number().int().min(1).default(48),
    })
    .prefault({}),
  /** M9: the fixed theme list that complaints and repeat problems group by (D5; audited when edited). */
  extraction: z.object({ themes: themeSettingSchema.default([...DEFAULT_THEMES]) }).prefault({}),
  /** M7: the renewal radar's horizon and the confidence model's weights (audited when edited). */
  renewals: renewalSettings,
  /** M11 (D-167): when a signal rule "cries wolf". Measurement only; changes no rule or model. */
  accuracy: z
    .object({
      criesWolfRate: z.number().min(0).max(1).default(0.4),
      criesWolfMinDetermined: z.number().int().min(1).default(5),
      windowDays: z.number().int().min(1).max(730).default(90),
    })
    .prefault({}),
  approvals: z
    .object({
      /** The highest level any action may reach in this workspace (ARCHITECTURE §7.3). */
      workspaceCeiling: z
        .enum([
          "NOTIFY_ONLY",
          "DRAFT_FOR_APPROVAL",
          "DRAFT_IN_MAILBOX",
          "DO_AUTOMATICALLY",
          "SEND_AUTOMATICALLY",
        ])
        .default("DO_AUTOMATICALLY"),
    })
    .prefault({}),
});

export type WorkspaceSettingsData = z.infer<typeof workspaceSettingsData>;

/** The disclosure shown beside the toggle and under the dictation button (Q-11). */
export const VOICE_DICTATION_DISCLOSURE =
  "When on, the Ask AI box offers your browser's dictation. Audio is handled by your browser vendor, not by NexaWorks; no audio reaches our servers.";
