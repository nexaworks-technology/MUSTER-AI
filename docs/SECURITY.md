# Security overview

Status as of 2026-11-06 (M12 in progress). This is an honest description of what is built and tested in
the repository today, and what is not yet verified. Nothing is deployed and nothing has been pushed to a
remote; the host-level items below are plans, not facts.

No certificate is held or claimed. The controls are designed to be **SOC 2-aligned**. A SOC 2 Type II
report is a roadmap item; the date is to be set by the founder.

## Tenant isolation (Rule 2)
- Every tenant table carries `workspaceId` and has PostgreSQL row-level security. The application connects
  as a non-owner role, so RLS applies to it; the owner role is used only for migrations.
- All domain access goes through `scopedDb` (`src/lib/db/scoped.ts`), which sets the workspace for the
  connection/transaction and adds the scope to queries. Nested scoped operations join the open tenant
  transaction (D-174).
- Automated checks that try to break it: per-milestone `tenant-isolation-*.int.test.ts`, and
  `tenant-enumeration.int.test.ts` (M12 A6), which walks every Server Action, Route Handler and Ask AI tool
  with another workspace's ids.
- **AI bundles (Rule 8):** `src/lib/ai/__tests__/bundle-isolation.int.test.ts` prepares every registered agent
  in workspace A with workspace B present, and asserts every record in the model-bound context exists in A
  and none in B; a forged B id under A's context yields nothing of B's. Ask AI retrieval is tested the same
  way. `adoption-coach` and `champion-guard` are only covered on the forged-id path (their own-bundle needs
  richer fixtures).

## Access control (RBAC) and money redaction
- Roles and permissions: `src/lib/auth/permissions.ts`; book scope limits which accounts a member sees.
- Money is hidden from members without `canViewRevenue`: server-side redaction across every financial
  projection, covered by the M12 A7 full-matrix test (`revenue-redaction.int.test.ts`).

## Transport and storage encryption
- **In transit:** TLS is terminated at the host. The plan is Fly.io; it is **not deployed yet**, so this is
  unverified. The app sends HSTS in production (below).
- **At rest:** the plan is managed Postgres and S3-compatible storage with host-side encryption at rest.
  **To be confirmed in Session C** against the real provider settings; not verified today.
- **Field encryption:** sensitive columns (e.g. integration credentials, `credentialsEnc`) are encrypted in
  the application with AES-256-GCM (`src/lib/crypto`), key from `FIELD_ENCRYPTION_KEY`, with a key id prefix
  so old ciphertext stays readable after rotation.

## Secrets handling (Rule 9)
- Secrets come from environment variables by name only; `.env.example` lists names, never values.
- `scripts/check-secrets.ts` scans the working tree; `scripts/check-secrets-history.ts` scans every blob and
  commit/tag message in git history. Both are part of CI (`.github/workflows/ci.yml`, **unverified until a
  remote exists**).
- History was rewritten once, before any push or share (D-172, `docs/HISTORY_REWRITE_MAP.md`); exposed local
  passwords were rotated. The pre-rewrite copy is kept locally outside the repo.
- Logging (`src/lib/logger`): pino with path redaction plus a deep scrub at any nesting level, inside `err`
  objects, and on key-shaped strings (`sk-...`, `Bearer ...`). Covers tokens, `credentialsEnc`, passwords,
  headers, email bodies and AI content fields (`prompt`, `system`, `input`, `output`, `answer`). Tested in
  `src/lib/__tests__/log-redaction.test.ts`. Policy remains: log ids, counts and timings, not content.
- Dependency audit: `pnpm audit` results and recommended actions are in
  `docs/milestones/m12-evidence/a11-audit.txt`. Upgrades are a founder decision.

## Headers, CSP and cookies (D-175)
- Per-request nonce CSP, HSTS (production), `nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`,
  `Referrer-Policy`, `Permissions-Policy`. Auth cookies are HttpOnly, SameSite=Lax, Secure (prefixed in
  production). Production-build behaviour in a real browser is still to be proven (B7).

## Rate limits
- See M12 A9. (Session A9, in progress; this section is not yet written.)

## Audit log (Rule 5)
- `AuditLog` is append-only at the database level; values that look like secrets are redacted before storage.
- Every agent run writes an `AgentRun` (input ids, prompt version, model, structured output, confidence,
  action, approver, outcome). Customer contact needs approval by default (Rule 3).

## AI data use (Rule 8, Q-19)
In code: the only data that leaves the workspace boundary to a third party is the prompt for the AI call that
serves that same workspace. No customer data is used to train shared models by us. Numbers (health, risk,
forecast, money) are computed by deterministic code, not by the model (D-75).

**What Anthropic's public commercial terms say** (read 2026-11-06; this records the public terms only):
- Training: the Commercial Terms of Service (https://www.anthropic.com/legal/commercial-terms, effective
  2025-06-17) state that Anthropic "may not train models on Customer Content from Services", and the customer
  owns its Outputs. Data is processed under Anthropic's Data Processing Addendum, which is not reproduced there.
- Retention: Anthropic's privacy centre
  (https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) says API inputs
  and outputs are deleted automatically within 30 days by default. Exceptions it lists: a zero-data-retention
  (ZDR) agreement replaces the default; content flagged by trust-and-safety systems may be kept up to 2 years
  (classification scores up to 7 years); longer retention where law requires it; features such as the Files API
  keep data until you delete it. Some third-party pages claim a shorter default; I could not confirm that on an
  Anthropic page, so it is not relied on.

**Not verified:** the founder's own Anthropic account terms (for example whether a ZDR agreement exists, the
DPA signed, or the org's retention settings). That needs the founder (Session C / pilot). Settings > Data
controls must state only what is verified. If ZDR is required, check feature compatibility (e.g. caching and the
Files API) before relying on it.
