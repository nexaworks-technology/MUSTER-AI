import { z } from "zod";
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
