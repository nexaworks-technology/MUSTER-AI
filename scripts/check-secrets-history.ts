/**
 * Full-history secret scan (M12 rule 1, Q-78): every blob reachable from every ref and every
 * commit and tag message, through the same patterns as `check-secrets.ts`, plus an optional list of
 * KNOWN leaked literals read from a local file that is never committed (`--known <file>`, one value
 * per line). Prints object ids and paths, never a matched value. Exit 1 on any finding.
 *
 *   pnpm exec tsx scripts/check-secrets-history.ts [--repo <path>] [--known <file>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scanText } from "./secret-patterns";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const repo = arg("repo") ?? process.cwd();
const git = (args: string[], input?: string) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    ...(input !== undefined ? { input } : {}),
  });
const known = arg("known")
  ? readFileSync(arg("known")!, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length >= 4)
  : [];
const MAX_BLOB = 2_000_000;

interface Finding {
  where: string;
  rule: string;
}
const findings: Finding[] = [];
const scan = (where: string, text: string) => {
  for (const f of scanText(where, text))
    findings.push({ where: `${where}:${f.line}`, rule: f.rule });
  known.forEach((value, i) => {
    if (text.includes(value)) findings.push({ where, rule: `known-leaked-value#${i + 1}` });
  });
};

// Every object reachable from every ref (branches, tags, notes, stash), with the first path seen.
const objects = git(["rev-list", "--objects", "--all"])
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const sp = l.indexOf(" ");
    return sp < 0 ? { id: l, path: "" } : { id: l.slice(0, sp), path: l.slice(sp + 1) };
  });
const types = git(
  ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
  objects.map((o) => o.id).join("\n") + "\n",
)
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split(" "));
const pathOf = new Map(objects.map((o) => [o.id, o.path]));
let blobs = 0;
let commits = 0;
let tags = 0;
for (const [id, type, size] of types) {
  if (type === "blob") {
    if (Number(size) > MAX_BLOB) continue;
    const buf = execFileSync("git", ["-C", repo, "cat-file", "blob", id!], { maxBuffer: 1 << 30 });
    if (buf.includes(0)) continue; // binary
    blobs++;
    scan(`blob ${id!.slice(0, 12)} ${pathOf.get(id!) ?? ""}`, buf.toString("utf8"));
  } else if (type === "commit") {
    commits++;
    const body = git(["cat-file", "commit", id!]);
    scan(`commit ${id!.slice(0, 12)} message`, body.slice(body.indexOf("\n\n") + 2));
  } else if (type === "tag") {
    tags++;
    scan(`tag ${id!.slice(0, 12)}`, git(["cat-file", "tag", id!]));
  }
}

console.log(
  `history-secret-check: ${commits} commits, ${blobs} text blobs, ${tags} tags scanned in ${repo}` +
    (known.length ? ` (+${known.length} known leaked values)` : ""),
);
for (const f of findings) console.log(`  ${f.rule}  ${f.where}`);
if (findings.length) {
  console.log(`history-secret-check: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log("history-secret-check: no secrets found");
