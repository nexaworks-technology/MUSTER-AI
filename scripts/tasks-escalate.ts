/**
 * `pnpm exec tsx --env-file=.env scripts/tasks-escalate.ts --workspace <slug>`
 *
 * Runs the overdue-task escalation once for a workspace (the worker runs it hourly). Safe to
 * re-run: an escalated task is never escalated twice.
 */
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { escalateOverdueTasks } from "@/modules/tasks/service";

async function main() {
  const i = process.argv.indexOf("--workspace");
  const slug = i >= 0 ? process.argv[i + 1] : undefined;
  if (!slug) throw new Error("usage: … --workspace <slug>");
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  const r = await escalateOverdueTasks({ workspaceId: ws.id });
  console.log(`escalated ${r.escalated} overdue task(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
