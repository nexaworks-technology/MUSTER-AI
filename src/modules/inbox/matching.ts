/**
 * Which account an inbound email belongs to (M9 §2): the sender's exact contact email first, then
 * the sender's domain when exactly one account uses it. Anything ambiguous or unknown is UNMATCHED
 * with a plain reason and its candidates; it is never auto-assigned (Rule 4: no invented link).
 * Pure; the service feeds it the workspace's own contacts and accounts, so it cannot see another
 * workspace's.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "fastmail.com",
]);

export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!
    .trim();
  return d.includes(".") ? d : null;
}

/** The bare address from `Name <a@b.test>` or `a@b.test`, lower-cased; null when there is none. */
export function senderAddress(from: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(from);
  return m ? m[1]!.toLowerCase() : null;
}

export function senderDomain(from: string): string | null {
  const a = senderAddress(from);
  return a ? a.slice(a.lastIndexOf("@") + 1) : null;
}

export interface MatchInput {
  from: string;
  contacts: ReadonlyArray<{ id: string; email: string | null; accountId: string }>;
  accounts: ReadonlyArray<{ id: string; domain: string | null }>;
}

export type MatchResult =
  | {
      kind: "MATCHED";
      accountId: string;
      contactId: string | null;
      matchedBy: "CONTACT_EMAIL" | "DOMAIN";
    }
  | { kind: "UNMATCHED"; reason: string; candidateAccountIds: string[] };

const unmatched = (reason: string, candidateAccountIds: string[] = []): MatchResult => ({
  kind: "UNMATCHED",
  reason,
  candidateAccountIds,
});

export function matchSender(i: MatchInput): MatchResult {
  const address = senderAddress(i.from);
  if (!address) return unmatched("The sender address could not be read.");
  const byEmail = i.contacts.filter((c) => c.email?.toLowerCase() === address);
  const emailAccounts = [...new Set(byEmail.map((c) => c.accountId))];
  if (emailAccounts.length === 1)
    return {
      kind: "MATCHED",
      accountId: emailAccounts[0]!,
      contactId: byEmail[0]!.id,
      matchedBy: "CONTACT_EMAIL",
    };
  if (emailAccounts.length > 1)
    return unmatched(
      `${address} is a contact on ${emailAccounts.length} accounts, so it cannot be placed on one.`,
      emailAccounts,
    );
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (FREE_MAIL_DOMAINS.has(domain))
    return unmatched(`${domain} is a personal mail domain and is not matched by domain.`);
  const byDomain = i.accounts.filter((a) => normalizeDomain(a.domain) === domain);
  if (byDomain.length === 1)
    return { kind: "MATCHED", accountId: byDomain[0]!.id, contactId: null, matchedBy: "DOMAIN" };
  if (byDomain.length > 1)
    return unmatched(
      `${byDomain.length} accounts share ${domain}, so it cannot be placed on one.`,
      byDomain.map((a) => a.id),
    );
  return unmatched(`No contact or account uses ${domain}.`);
}
