import { z } from "zod";

/**
 * Data-quality detector (spec §6A6, D-49). Pure: finds duplicate accounts and contacts, messy
 * or invalid emails and stale accounts, and proposes a fix. Only "safe" fixes are applicable,
 * and only after a person confirms. Nothing here changes data.
 */
export interface DqAccount {
  id: string;
  name: string;
  domain: string | null;
  lifecycleStage: string;
  createdAt: Date;
  updatedAt: Date;
  lastTouchAt: Date | null;
}

export interface DqContact {
  id: string;
  accountId: string;
  name: string;
  email: string | null;
  createdAt: Date;
}

export const dqFix = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NONE") }),
  z.object({
    type: z.literal("MERGE_CONTACTS"),
    keepId: z.string(),
    removeIds: z.array(z.string()).min(1),
  }),
  z.object({ type: z.literal("NORMALIZE_EMAIL"), contactId: z.string(), email: z.string() }),
]);
export type DqFix = z.infer<typeof dqFix>;

export interface DetectedIssue {
  kind: "DUPLICATE_ACCOUNT" | "DUPLICATE_CONTACT" | "INVALID_EMAIL" | "STALE";
  accountId: string | null;
  contactId: string | null;
  detail: string;
  fix: DqFix;
  dedupeKey: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUFFIX = /\b(inc|incorporated|ltd|limited|llc|plc|gmbh|co|corp|corporation|company)\b/g;

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const normDomain = (d: string | null) =>
  d
    ? d
        .trim()
        .toLowerCase()
        .replace(/^www\./, "")
    : null;
const normEmail = (e: string | null) => (e ? e.trim().toLowerCase() : null);
const normName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ");
const byAge = <T extends { createdAt: Date; id: string }>(a: T, b: T) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

const keySet = (g: Array<{ id: string }>) =>
  g
    .map((x) => x.id)
    .sort()
    .join(",");

/** Union-find over pairs, so A~B and B~C become one group {A, B, C}. */
function groups<T extends { id: string }>(
  items: T[],
  keysOf: (t: T) => Array<string | null>,
): T[][] {
  const parent = new Map(items.map((i) => [i.id, i.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  const seen = new Map<string, string>();
  for (const item of items) {
    for (const key of keysOf(item)) {
      if (!key) continue;
      const other = seen.get(key);
      if (other) parent.set(find(item.id), find(other));
      else seen.set(key, item.id);
    }
  }
  const out = new Map<string, T[]>();
  for (const item of items) out.set(find(item.id), [...(out.get(find(item.id)) ?? []), item]);
  return [...out.values()].filter((g) => g.length > 1);
}

export function detectIssues(input: {
  accounts: DqAccount[];
  contacts: DqContact[];
  now: Date;
  staleAfterDays: number;
}): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const accountName = new Map(input.accounts.map((a) => [a.id, a.name]));

  for (const g of groups(input.accounts, (a) => [
    normDomain(a.domain) && `d:${normDomain(a.domain)}`,
    `n:${normalizeCompanyName(a.name)}`,
  ])) {
    const [keep, ...rest] = [...g].sort(byAge);
    issues.push({
      kind: "DUPLICATE_ACCOUNT",
      accountId: keep!.id,
      contactId: null,
      detail: `"${keep!.name}" looks like the same company as ${rest.map((r) => `"${r.name}"`).join(", ")} (same domain or name). Review and merge them by hand.`,
      fix: { type: "NONE" },
      dedupeKey: `dup-account:${keySet(g)}`,
    });
  }

  // Same account: one person recorded twice (by email or name) → a safe merge.
  for (const g of groups(input.contacts, (c) => [
    normEmail(c.email) && `e:${c.accountId}:${normEmail(c.email)}`,
    `n:${c.accountId}:${normName(c.name)}`,
  ])) {
    const [keep, ...rest] = [...g].sort(byAge);
    issues.push({
      kind: "DUPLICATE_CONTACT",
      accountId: keep!.accountId,
      contactId: keep!.id,
      detail: `${g.length} contact records for ${keep!.name} at ${accountName.get(keep!.accountId) ?? "this account"}. Merging keeps the oldest record and moves roles, messages, tickets and usage onto it.`,
      fix: { type: "MERGE_CONTACTS", keepId: keep!.id, removeIds: rest.map((r) => r.id) },
      dedupeKey: `dup-contact:${keySet(g)}`,
    });
  }

  // Different accounts sharing an email: flagged for a person, never merged automatically.
  const byEmail = new Map<string, DqContact[]>();
  for (const c of input.contacts) {
    const e = normEmail(c.email);
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), c]);
  }
  for (const g of byEmail.values()) {
    const accounts = [...new Set(g.map((c) => c.accountId))];
    if (accounts.length < 2) continue;
    const [first] = [...g].sort(byAge);
    issues.push({
      kind: "DUPLICATE_CONTACT",
      accountId: first!.accountId,
      contactId: first!.id,
      detail: `${first!.name} appears on ${accounts.length} different accounts (${accounts.map((a) => accountName.get(a)).join(", ")}). Check which account they belong to.`,
      fix: { type: "NONE" },
      dedupeKey: `cross-account-contact:${keySet(g)}`,
    });
  }

  for (const c of input.contacts) {
    if (!c.email) continue;
    const clean = normEmail(c.email)!;
    if (!EMAIL.test(clean)) {
      issues.push({
        kind: "INVALID_EMAIL",
        accountId: c.accountId,
        contactId: c.id,
        detail: `${c.name}'s email "${c.email}" is not a valid address. Correct it at the source.`,
        fix: { type: "NONE" },
        dedupeKey: `bad-email:${c.id}`,
      });
    } else if (clean !== c.email) {
      issues.push({
        kind: "INVALID_EMAIL",
        accountId: c.accountId,
        contactId: c.id,
        detail: `${c.name}'s email has extra spaces or capital letters ("${c.email}").`,
        fix: { type: "NORMALIZE_EMAIL", contactId: c.id, email: clean },
        dedupeKey: `messy-email:${c.id}`,
      });
    }
  }

  const staleBefore = input.now.getTime() - input.staleAfterDays * 86_400_000;
  for (const a of input.accounts) {
    if (a.lifecycleStage === "LOST") continue;
    const lastActivity = Math.max(a.updatedAt.getTime(), a.lastTouchAt?.getTime() ?? 0);
    if (lastActivity < staleBefore) {
      issues.push({
        kind: "STALE",
        accountId: a.id,
        contactId: null,
        detail: `"${a.name}" has had no updates and no contact for over ${input.staleAfterDays} days. Check that its details are still right.`,
        fix: { type: "NONE" },
        dedupeKey: `stale:${a.id}`,
      });
    }
  }
  // Stable order: by kind, then account, then key.
  const order = ["DUPLICATE_ACCOUNT", "DUPLICATE_CONTACT", "INVALID_EMAIL", "STALE"];
  return issues.sort(
    (x, y) =>
      order.indexOf(x.kind) - order.indexOf(y.kind) || x.dedupeKey.localeCompare(y.dedupeKey),
  );
}
