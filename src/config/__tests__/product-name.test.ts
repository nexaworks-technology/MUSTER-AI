import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../product";

/** Q-01: the product name is one config value; no code may spell it out. */
describe("PRODUCT_NAME", () => {
  it("appears literally only in src/config/product.ts", () => {
    let hits = "";
    try {
      hits = execFileSync(
        "git",
        ["grep", "-l", "--fixed-strings", PRODUCT_NAME, "--", "src", "e2e", "prisma", "scripts"],
        {
          encoding: "utf8",
        },
      );
    } catch {
      hits = ""; // git grep exits 1 when nothing matches
    }
    expect(hits.trim().split("\n").filter(Boolean)).toEqual(["src/config/product.ts"]);
  });
});
