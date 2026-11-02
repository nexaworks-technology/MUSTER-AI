/**
 * Emits the row-level-security SQL every [W] table needs (ARCHITECTURE §7.1). Paste the output
 * into the migration that creates the table:
 *
 *   pnpm exec tsx prisma/sql/rls.ts Membership Invitation
 *
 * The policy compares against the transaction-local setting written by scopedDb(). FORCE makes
 * the policy apply to the table owner too, so no runtime role can read across workspaces.
 */
export function tenantRlsSql(table: string): string {
  const t = `"${table.replaceAll('"', "")}"`;
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY tenant_isolation ON ${t}`,
    `  USING ("workspaceId" = current_setting('app.workspace_id', true))`,
    `  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));`,
  ].join("\n");
}

/**
 * Rule 5 at the database level: a row written by AI must name its AgentRun. Add to every table
 * with `origin` + `agentRunId` columns.
 */
export function agentRunCheckSql(table: string): string {
  const t = `"${table.replaceAll('"', "")}"`;
  return `ALTER TABLE ${t} ADD CONSTRAINT ${table.toLowerCase()}_agent_run_required\n  CHECK ("origin" <> 'AI' OR "agentRunId" IS NOT NULL);`;
}

if (process.argv[1]?.endsWith("rls.ts")) {
  const tables = process.argv.slice(2);
  if (tables.length === 0) {
    console.error("usage: pnpm exec tsx prisma/sql/rls.ts <Table> [<Table> ...]");
    process.exit(1);
  }
  const withCheck = new Set((process.env.AGENT_RUN_CHECK ?? "").split(",").filter(Boolean));
  console.log(
    tables
      .map((t) =>
        withCheck.has(t) ? `${tenantRlsSql(t)}\n${agentRunCheckSql(t)}` : tenantRlsSql(t),
      )
      .join("\n\n"),
  );
}
