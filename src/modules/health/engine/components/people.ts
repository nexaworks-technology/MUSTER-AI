import type { AccountBundle, ContactStatus, RoleType } from "../types";

/** Point-in-time people facts shared by Engagement and Relationship (D-56). */
type Role = AccountBundle["roles"][number];
type Contact = AccountBundle["contacts"][number];

/** Roles we knew about on the as-of date. */
export const rolesKnown = (b: AccountBundle, type?: RoleType) =>
  b.roles.filter((r) => r.validFrom <= b.asOf && (!type || r.role === type));

export const validOn = (r: Role, d: string) =>
  r.validFrom <= d && (r.validTo === null || r.validTo > d);

/** A status counts only from the date it became true; before that the contact was active. */
export function statusAsOf(c: Contact, asOf: string): ContactStatus {
  if (c.status === "ACTIVE" || c.status === "UNKNOWN") return "ACTIVE";
  return c.statusDate === null || c.statusDate <= asOf ? c.status : "ACTIVE";
}

const latest = (rs: Role[]) =>
  [...rs].sort((x, y) =>
    x.validFrom > y.validFrom ? -1 : x.validFrom < y.validFrom ? 1 : x.id < y.id ? -1 : 1,
  )[0];

export function currentHolder(b: AccountBundle, type: RoleType) {
  const role = latest(rolesKnown(b, type).filter((r) => validOn(r, b.asOf)));
  if (!role) return null;
  const contact = b.contacts.find((c) => c.id === role.contactId);
  return contact ? { role, contact } : null;
}

export const currentChampion = (b: AccountBundle) => currentHolder(b, "CHAMPION");

/** The most recently ended role of this type (validTo on or before the as-of date). */
export function lastEnded(b: AccountBundle, type: RoleType) {
  const ended = rolesKnown(b, type).filter((r) => r.validTo !== null && r.validTo <= b.asOf);
  const role = [...ended].sort((x, y) => (x.validTo! > y.validTo! ? -1 : 1))[0];
  if (!role) return null;
  const contact = b.contacts.find((c) => c.id === role.contactId);
  return contact ? { role, contact } : null;
}
