/**
 * Fails when a tracked or staged file contains a credential-like string (Rule 9).
 * Prints file, line and rule name only — never the matched text.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { scanText } from "./secret-patterns";

const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|zip|woff2?|ttf)$/i;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f !== "" && !BINARY.test(f) && f !== "pnpm-lock.yaml");

const findings = files.flatMap((file) => {
  try {
    if (statSync(file).size > 2_000_000) return [];
    return scanText(file, readFileSync(file, "utf8"));
  } catch {
    return []; // deleted in the working tree
  }
});

if (findings.length > 0) {
  for (const f of findings) console.error(`secret-check: ${f.file}:${f.line} (${f.rule})`);
  console.error(
    `secret-check: ${findings.length} finding(s). Remove the value; refer to env var names only.`,
  );
  process.exit(1);
}
console.log(`secret-check: ${files.length} files scanned, no secrets found`);
