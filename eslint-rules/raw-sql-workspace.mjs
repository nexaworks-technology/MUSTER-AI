/**
 * D-40 (ARCHITECTURE §7.1): raw SQL must scope itself to the caller's workspace.
 *
 * - `$queryRawUnsafe` / `$executeRawUnsafe` are refused outright (no placeholders, no proof).
 * - `$queryRaw` / `$executeRaw` must be given an inline template (tagged, or `Prisma.sql`) that
 *   contains `"workspaceId" = ${<…>workspaceId}`, so the workspace filter is visible in the SQL
 *   itself. RLS already limits the scoped client; this keeps the query honest on its own.
 *
 * Files that may use raw SQL without the filter are named one by one in eslint.config.mjs.
 */
const RAW = new Set(["$queryRaw", "$executeRaw"]);
const UNSAFE = new Set(["$queryRawUnsafe", "$executeRawUnsafe"]);

const propName = (node) =>
  node?.type === "MemberExpression" && node.property.type === "Identifier"
    ? node.property.name
    : null;

/** The template a raw call runs: tagged directly, or passed as a `Prisma.sql` template. */
function templateOf(node) {
  if (node.type === "TaggedTemplateExpression") return node.quasi;
  const arg = node.arguments?.[0];
  if (arg?.type === "TaggedTemplateExpression" && propName(arg.tag) === "sql") return arg.quasi;
  return null;
}

function scopesWorkspace(template, source) {
  return template.quasis.some((q, i) => {
    const expr = template.expressions[i];
    return (
      expr && /"workspaceId"\s*=\s*$/.test(q.value.raw) && /workspaceId$/.test(source.getText(expr))
    );
  });
}

const rawSqlWorkspace = {
  meta: {
    type: "problem",
    docs: { description: "Raw SQL must filter by the caller's workspaceId (D-40)" },
    messages: {
      unsafe: "{{name}} is not allowed: use a tagged $queryRaw/$executeRaw template (D-40).",
      notInline:
        "Raw SQL must be an inline template so its workspace filter can be checked (D-40).",
      unscoped: 'Raw SQL must include `"workspaceId" = ${…workspaceId}` (D-40, ARCHITECTURE §7.1).',
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode;
    const check = (node, callee) => {
      const name = propName(callee);
      if (UNSAFE.has(name)) return context.report({ node, messageId: "unsafe", data: { name } });
      if (!RAW.has(name)) return;
      const template = templateOf(node);
      if (!template) return context.report({ node, messageId: "notInline" });
      if (!scopesWorkspace(template, source)) context.report({ node, messageId: "unscoped" });
    };
    return {
      TaggedTemplateExpression: (node) => check(node, node.tag),
      CallExpression: (node) => check(node, node.callee),
    };
  },
};

export default rawSqlWorkspace;
