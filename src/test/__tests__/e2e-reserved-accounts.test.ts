import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_ACCOUNTS } from "../../../e2e/support/reserved-accounts";

/**
 * M12 B7 guard — e2e isolation: an account an e2e spec changes for good is reserved by exactly
 * one spec, the reservation still matches the code, and no other spec mutates it.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const MUTATING = /recordRenewalOutcome\(|--account|demo-m11-save-chain|openThread\([^)]*"Move /;

describe("e2e reserved accounts", () => {
  it("no account is reserved twice", () => {
    const names = RESERVED_ACCOUNTS.map((r) => r.account);
    expect(new Set(names).size).toBe(names.length);
  });

  it("each reservation's spec exists and its files still name the account", () => {
    for (const r of RESERVED_ACCOUNTS) {
      expect(existsSync(path.join(ROOT, r.spec)), r.spec).toBe(true);
      for (const f of r.namedIn) expect(read(f), `${f} names ${r.account}`).toContain(r.account);
    }
  });

  it("no other spec mutates a reserved account", () => {
    const specs = readdirSync(path.join(ROOT, "e2e")).filter((f) => f.endsWith(".spec.ts"));
    for (const file of specs) {
      const lines = read(`e2e/${file}`).split("\n");
      for (const r of RESERVED_ACCOUNTS) {
        if (r.spec === `e2e/${file}`) continue;
        const hit = lines.find((l) => l.includes(r.account) && MUTATING.test(l));
        expect(hit, `e2e/${file} mutates ${r.account}, reserved by ${r.spec}`).toBeUndefined();
      }
    }
  });
});
