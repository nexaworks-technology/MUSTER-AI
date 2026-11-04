import type { ExtractionSourceType, PromiseParty } from "@prisma/client";

/**
 * Who made a promise, decided by code from the source (M9 D11, Rule 2: the model proposes, code
 * decides). A message's direction settles it; a call line's speaker settles it when the name
 * matches exactly one side (a member of ours, or a contact of theirs). Otherwise it is "Not clear
 * from the text". The model's own guess is kept only as a flagged suggestion on an unclear one.
 */
export interface PromisePartyInput {
  sourceType: ExtractionSourceType;
  direction?: "INBOUND" | "OUTBOUND";
  quote: string;
  sourceText: string;
  members: readonly string[];
  contacts: readonly string[];
  modelGuess?: "us" | "customer" | null;
}

export interface PromisePartyResult {
  party: PromiseParty;
  suggestedParty: PromiseParty | null;
  reason: string;
}

export const NOT_CLEAR = "Not clear from the text";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function speakerOf(sourceText: string, quote: string): string | null {
  const q = norm(quote);
  for (const line of sourceText.split("\n")) {
    const m = /^([^:\n]{1,60}):\s+(.*)$/.exec(line);
    if (m && norm(m[2]!).includes(q)) return m[1]!.replace(/\s+/g, " ").trim();
  }
  return null;
}

function decide(i: PromisePartyInput): { party: PromiseParty; reason: string } | null {
  if (i.sourceType === "MESSAGE" && i.direction)
    return i.direction === "OUTBOUND"
      ? { party: "US", reason: "Sent by us" }
      : { party: "CUSTOMER", reason: "Written by the customer" };
  if (i.sourceType !== "CALL_TRANSCRIPT") return null;
  const who = speakerOf(i.sourceText, i.quote);
  if (!who) return null;
  const ours = i.members.some((m) => norm(m) === norm(who));
  const theirs = i.contacts.some((c) => norm(c) === norm(who));
  if (ours === theirs) return null;
  return ours
    ? { party: "US", reason: `Said by ${who}, one of us` }
    : { party: "CUSTOMER", reason: `Said by ${who}, a contact at the customer` };
}

export function promiseParty(i: PromisePartyInput): PromisePartyResult {
  const d = decide(i);
  if (d) return { ...d, suggestedParty: null };
  const guess: PromiseParty | null =
    i.modelGuess === "us" ? "US" : i.modelGuess === "customer" ? "CUSTOMER" : null;
  return { party: "UNCLEAR", suggestedParty: guess, reason: NOT_CLEAR };
}
