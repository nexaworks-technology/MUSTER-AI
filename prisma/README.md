# Prisma conventions

Read with `docs/ARCHITECTURE.md` §3.1 and §7.1. Every rule below is enforced by a test in
`src/lib/db/__tests__/model-registry.int.test.ts`.

## Roles

- `DATABASE_URL` connects as **app_user**: not superuser, not table owner, `NOBYPASSRLS`. The app
  and the worker always use it.
- `DATABASE_URL_MIGRATE` connects as **nexaworks_owner** and is used only by `prisma migrate`
  (via `directUrl`). Roles come from `docker/postgres/roles.sql`.

## Adding a workspace-scoped [W] model

1. Add `workspaceId String` and a relation to `Workspace`.
2. Add `@@unique([workspaceId, id])`, so children can reference it with a composite FK.
3. Reference other [W] parents **through the composite key**, so a row can never point at a parent
   in another workspace:
   ```prisma
   invitedBy Membership @relation(fields: [workspaceId, invitedByMembershipId], references: [workspaceId, id])
   ```
4. Start hot indexes with `workspaceId`.
5. Create the migration with `pnpm exec prisma migrate dev --create-only --name <name>`, then append
   the RLS block printed by `pnpm exec tsx prisma/sql/rls.ts <Model>`, then run `pnpm db:migrate`.
6. Add the model name to `TENANT_MODELS` in `src/lib/db/tenantModels.ts`, and add it to the tenant
   isolation suite.

Creates through `scopedDb(ctx)` pass `workspaceId: ctx.workspaceId` (Prisma's types require it). The
client rejects any other value, and reads, updates and deletes are scoped automatically.

Global [G] models (identity tables, `Workspace`, `OutboxEvent`) are listed in `GLOBAL_MODELS`.
Adding one needs a DECISIONS entry.

## Session settings read by RLS policies

| Setting                 | Set by                              | Used by                                         |
| ----------------------- | ----------------------------------- | ----------------------------------------------- |
| `app.workspace_id`      | `scopedDb(ctx)` for every operation | `tenant_isolation` policy on every [W] table    |
| `app.user_id`           | `src/lib/auth` membership lookups   | `membership_self_read` (SELECT own memberships) |
| `app.invite_token_hash` | invitation acceptance               | `invitation_token_read` (SELECT one invitation) |

All three are transaction-local (`set_config(..., true)`), so they never leak across pooled connections.

## Append-only audit

A trigger rejects `UPDATE`/`DELETE` on `"AuditLog"`. The M12 workspace purge will add the only exception.
