import { createHash } from "node:crypto";

/** Stable ids from seed keys (docs/SEED_DATA.md §1), so tests and fixtures can name story records. */
export function seedId(key: string): string {
  return `seed${createHash("sha1").update(key).digest("hex").slice(0, 21)}`;
}

export const ids = {
  workspace: "workspace:larkspur",
  membership: (user: "leo" | "aisha" | "priya" | "dana" | "tom") =>
    seedId(`workspace:larkspur:user:${user}`),
  account: (key: string) => seedId(`account:${key}`),
  contact: (account: string, contact: string) => seedId(`contact:${account}:${contact}`),
};
