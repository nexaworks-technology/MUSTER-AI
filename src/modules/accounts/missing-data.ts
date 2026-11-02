/**
 * Missing-data helper rules (spec §6A5, QUESTIONS Q-09 as superseded by founder decision C2).
 * Pure: given what is missing on an account and the prompt history, decide the ONE question to
 * show this viewer, if any. It only ever asks; missing data never lowers or blocks anything.
 */
export type MissingField = "OWNER" | "RENEWAL_DATE" | "KEY_CONTACT";

export interface MissingDataFacts {
  accountId: string;
  tier: "HIGH_TOUCH" | "MID_TOUCH" | "LONG_TAIL";
  ownerMembershipId: string | null;
  hasCurrentContract: boolean;
  renewalDateMissing: boolean;
  hasContacts: boolean;
  hasKeyContact: boolean;
}

export interface PromptState {
  field: MissingField;
  answeredAt: Date | null;
  snoozeUntil: Date | null;
  /** Already shown to this viewer today (counts toward nothing new). */
  askedToday?: boolean;
}

export interface Viewer {
  membershipId: string;
  role: "ADMIN" | "CS_LEADER" | "CSM" | "VIEWER";
}

export const QUESTIONS: Record<MissingField, string> = {
  OWNER: "Who owns this account?",
  RENEWAL_DATE: "When does this contract renew?",
  KEY_CONTACT: "Who is the champion at this account?",
};

const PRIORITY: MissingField[] = ["OWNER", "RENEWAL_DATE", "KEY_CONTACT"];

function missingFields(f: MissingDataFacts): MissingField[] {
  const out: MissingField[] = [];
  // Unowned long-tail accounts are the Digital CSM pool by design: no owner question.
  if (!f.ownerMembershipId && f.tier !== "LONG_TAIL") out.push("OWNER");
  if (f.hasCurrentContract && f.renewalDateMissing) out.push("RENEWAL_DATE");
  if (f.hasContacts && !f.hasKeyContact) out.push("KEY_CONTACT");
  return out;
}

/** The owner is asked; without an owner, Admins and CS Leaders are. */
export function isRightPerson(f: MissingDataFacts, viewer: Viewer): boolean {
  if (f.ownerMembershipId) return viewer.membershipId === f.ownerMembershipId;
  return viewer.role === "ADMIN" || viewer.role === "CS_LEADER";
}

export function nextMissingQuestion(input: {
  facts: MissingDataFacts;
  viewer: Viewer;
  prompts: readonly PromptState[];
  askedTodayByViewer: number;
  settings: { snoozeDays: number; maxPromptsPerUserPerDay: number };
  now: Date;
}): { field: MissingField; question: string } | null {
  if (!isRightPerson(input.facts, input.viewer)) return null;
  const state = new Map(input.prompts.map((p) => [p.field, p]));
  for (const field of PRIORITY) {
    if (!missingFields(input.facts).includes(field)) continue;
    const p = state.get(field);
    if (p?.answeredAt) continue;
    if (p?.snoozeUntil && p.snoozeUntil > input.now) continue;
    // A question already on screen today keeps showing; new ones respect the daily limit.
    if (!p?.askedToday && input.askedTodayByViewer >= input.settings.maxPromptsPerUserPerDay)
      return null;
    return { field, question: QUESTIONS[field] };
  }
  return null;
}
