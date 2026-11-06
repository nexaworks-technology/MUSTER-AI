/**
 * `pnpm test:e2e [playwright args…]` (M12 harness fix, D-186).
 *
 * Runs the main e2e config (app server on recorded AI), then the AI-off config (the suites written
 * against an app with no AI provider), strictly one after the other, so they can share the `_e2e`
 * database: each run's global setup recreates it. Arguments (spec files, `-g`, `--project`) go to
 * both; a run with no matching tests passes. The AI-off run has only a `desktop` project, so it is
 * skipped when `--project` names only others. Exit code: non-zero if either run failed.
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const run = (config: string[]) =>
  spawnSync("pnpm", ["exec", "playwright", "test", ...config, ...args, "--pass-with-no-tests"], {
    stdio: "inherit",
  }).status ?? 1;

const projects = args
  .flatMap((a, i) =>
    a.startsWith("--project=") ? [a.slice(10)] : a === "--project" ? [args[i + 1] ?? ""] : [],
  )
  .filter(Boolean);
const aiOffApplies = projects.length === 0 || projects.includes("desktop");

const main = run([]);
console.log(`\n[e2e] main run (recorded AI): ${main === 0 ? "passed" : "FAILED"}`);
let aiOff = 0;
if (aiOffApplies) {
  aiOff = run(["-c", "playwright.aioff.config.ts"]);
  console.log(`[e2e] AI-off run: ${aiOff === 0 ? "passed" : "FAILED"}`);
} else console.log("[e2e] AI-off run skipped: it has only the desktop project");
process.exit(main === 0 && aiOff === 0 ? 0 : 1);
