import { execFileSync } from "node:child_process";
import { rawDb } from "../../src/lib/db/raw";
import { E2E_SCRIPTS_QUEUE_PREFIX } from "./harness";

/**
 * M4 e2e support. The app under test has no AI key, so agent runs happen here, before the
 * browser steps, through the real executor on the RECORDED transport (scripts/recorded-agents.ts:
 * fixture answers composed from the records; no live model). The app then shows what those runs
 * stored, exactly as it would show live runs.
 */
/**
 * The environment every script a spec spawns runs with (M12 harness fix H2, D-186). It is set
 * explicitly, never left to the process defaults: the `_e2e` database (refused otherwise), the e2e
 * scripts' queue prefix (only the script's own in-process workers listen there), and recorded AI
 * (callers choose the recordings directory). The rest of the environment (Redis, storage, secrets
 * loaded from .env) passes through.
 */
export function e2eScriptEnv(callerEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const db = process.env.DATABASE_URL;
  const owner = process.env.DATABASE_URL_MIGRATE;
  for (const url of [db, owner])
    if (!url || !new URL(url).pathname.endsWith("_e2e"))
      throw new Error("e2e scripts run only against the _e2e database");
  return {
    ...process.env,
    ...callerEnv,
    NODE_ENV: "development",
    DATABASE_URL: db,
    DATABASE_URL_MIGRATE: owner,
    QUEUE_PREFIX: E2E_SCRIPTS_QUEUE_PREFIX,
    AI_PROVIDER: "recorded",
    ANTHROPIC_API_KEY: "", // never a live model from e2e
  };
}

export function runScript(file: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync("pnpm", ["exec", "tsx", file, ...args], {
    env: e2eScriptEnv(env),
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
