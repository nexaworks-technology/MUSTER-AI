import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { rawDb } from "./raw";
import { isTenantModel } from "./tenantModels";

/**
 * scopedDb(ctx) — the only database client feature code may use (ARCHITECTURE §7.1, Rule 2).
 *
 * Layer 1 (by construction): injects `workspaceId` into every where clause on [W] models and throws
 * TenantViolationError if a caller names a different workspace. Prisma's types still require
 * `workspaceId` in create data, so callers pass their own context's id; any mismatch throws.
 * Layer 2 (defense in depth): runs every operation in a transaction that first sets
 * `app.workspace_id`, so the Postgres RLS policy admits only this workspace's rows.
 */
export interface TenantContext {
  readonly workspaceId: string;
}

export class TenantViolationError extends Error {
  constructor(message: string) {
    super(`Tenant violation: ${message}`);
    this.name = "TenantViolationError";
  }
}

const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);
const UPDATE_OPS = new Set(["update", "updateMany", "updateManyAndReturn"]);

/** Workspace of the interactive tenant transaction currently running, if any. */
const activeTransaction = new AsyncLocalStorage<{ workspaceId: string }>();

type Args = Record<string, unknown>;

function isPlainObject(value: unknown): value is Args {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** Rejects any `workspaceId` anywhere in a where tree unless it is exactly this workspace. */
function assertWhere(where: unknown, workspaceId: string): void {
  if (Array.isArray(where)) return where.forEach((w) => assertWhere(w, workspaceId));
  if (!isPlainObject(where)) return;
  for (const [key, value] of Object.entries(where)) {
    if (key === "workspaceId" && value !== workspaceId) {
      throw new TenantViolationError(
        "a query named a different workspace (or a workspaceId filter)",
      );
    }
    assertWhere(value, workspaceId);
  }
}

function scopeData(data: unknown, workspaceId: string, setIt: boolean): unknown {
  if (Array.isArray(data)) return data.map((d) => scopeData(d, workspaceId, setIt));
  if (!isPlainObject(data)) return data;
  if ("workspace" in data) {
    throw new TenantViolationError(
      "set workspace through scopedDb, not a `workspace` relation write",
    );
  }
  if ("workspaceId" in data && data.workspaceId !== workspaceId) {
    throw new TenantViolationError("data named a different workspace");
  }
  const { workspaceId: _ignored, ...rest } = data;
  return setIt ? { ...rest, workspaceId } : rest;
}

function scopeArgs(operation: string, rawArgs: unknown, workspaceId: string): Args {
  const args: Args = isPlainObject(rawArgs) ? { ...rawArgs } : {};
  if (CREATE_OPS.has(operation)) {
    args.data = scopeData(args.data, workspaceId, true);
    return args;
  }
  assertWhere(args.where, workspaceId);
  args.where = { ...(isPlainObject(args.where) ? args.where : {}), workspaceId };
  if (UPDATE_OPS.has(operation)) args.data = scopeData(args.data, workspaceId, false);
  if (operation === "upsert") {
    args.create = scopeData(args.create, workspaceId, true);
    args.update = scopeData(args.update, workspaceId, false);
  }
  return args;
}

function setWorkspace(workspaceId: string) {
  return rawDb.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
}

/** Runs one Prisma operation under RLS for this workspace (or directly inside a tenant tx). */
async function underRls<T>(workspaceId: string, run: () => Prisma.PrismaPromise<T>): Promise<T> {
  const active = activeTransaction.getStore();
  if (active) {
    if (active.workspaceId !== workspaceId) {
      throw new TenantViolationError("operation for another workspace inside a tenant transaction");
    }
    return run();
  }
  const [, result] = await rawDb.$transaction([setWorkspace(workspaceId), run()]);
  return result;
}

function buildScopedClient(workspaceId: string) {
  return rawDb.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isTenantModel(model)) return query(args);
          const scoped = scopeArgs(operation, args, workspaceId);
          // `query` accepts the operation's own argument type; scopeArgs only adds workspaceId.
          return underRls(
            workspaceId,
            () => query(scoped as typeof args) as Prisma.PrismaPromise<unknown>,
          );
        },
      },
      async $queryRaw({ args, query }) {
        return underRls(workspaceId, () => query(args) as Prisma.PrismaPromise<unknown>);
      },
      async $executeRaw({ args, query }) {
        return underRls(workspaceId, () => query(args) as Prisma.PrismaPromise<number>);
      },
      async $queryRawUnsafe({ operation }) {
        throw new TenantViolationError(`${operation} is not allowed on a scoped client`);
      },
      async $executeRawUnsafe({ operation }) {
        throw new TenantViolationError(`${operation} is not allowed on a scoped client`);
      },
    },
    client: {
      /**
       * Interactive transaction for this workspace: sets app.workspace_id once, then every
       * operation in `fn` runs on the same connection with workspace injection still applied.
       */
      async $tenantTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
        const client = Prisma.getExtensionContext(this) as unknown as {
          $transaction: <R>(f: (tx: Prisma.TransactionClient) => Promise<R>) => Promise<R>;
        };
        return client.$transaction((tx) =>
          activeTransaction.run({ workspaceId }, async () => {
            await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
            return fn(tx);
          }),
        );
      },
    },
  });
}

export type ScopedDb = ReturnType<typeof buildScopedClient>;

export function scopedDb(ctx: TenantContext): ScopedDb {
  if (!ctx.workspaceId) throw new TenantViolationError("scopedDb needs a workspaceId");
  return buildScopedClient(ctx.workspaceId);
}
