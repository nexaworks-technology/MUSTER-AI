import { execFileSync } from "node:child_process";
import { rawDb } from "../../src/lib/db/raw";

/**
 * M4 e2e support. The app under test has no AI key, so agent runs happen here, before the
 * browser steps, through the real executor on the RECORDED transport (scripts/recorded-agents.ts:
 * fixture answers composed from the records; no live model). The app then shows what those runs
 * stored, exactly as it would show live runs.
 */
export function runScript(file: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync("pnpm", ["exec", "tsx", file, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function prepareM4(workspace: string): string {
  const agents = runScript("scripts/recorded-agents.ts", ["--workspace", workspace], {
    AI_PROVIDER: "recorded",
    AI_RECORDINGS_DIR: ".dev-recordings/e2e",
  });
  const escalated = runScript("scripts/tasks-escalate.ts", ["--workspace", workspace]);
  return `${agents}\n${escalated}`;
}

/** Runs a read on the given workspace with its RLS setting applied. */
export async function inWorkspace<T>(
  slug: string,
  fn: (tx: typeof rawDb, workspaceId: string) => Promise<T>,
) {
  const ws = await rawDb.workspace.findUniqueOrThrow({ where: { slug } });
  return rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws.id}, true)`;
    return fn(tx as unknown as typeof rawDb, ws.id);
  });
}
