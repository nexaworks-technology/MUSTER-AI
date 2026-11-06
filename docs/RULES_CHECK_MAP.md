# Rules check map

M12 acceptance #3: every rule in `CLAUDE.md` (1–9) has at least one automated check.
This file lists the strongest checks per rule. It is not a full list.

How to read it:

- A "check" is a test (file path and exact `describe` / `it` title), a lint rule, a database guard
  (RLS policy, trigger, constraint in `prisma/migrations`), an env refusal, or a secret scanner.
- "int" tests (`*.int.test.ts`) need the local Postgres. "unit" tests do not.
- The `pnpm lint` script runs ESLint and `scripts/check-secrets.ts` (`package.json`).
  `pnpm gate` = typecheck + lint + test + build (`package.json`).
- Titles were copied from the test files. If a title changes, this map is stale.
- Rule 4 of CLAUDE.md applies here: where a rule has only manual review, the Gaps column says so.

## Summary

| # | Rule | Checks listed | Gap |
|---|---|---|---|
| 1 | PROOF, NOT A SCORE | 6 | Partial: the database and the engine enforce proof for health and proposals. Whether every screen shows the link is not checked by one test. |
| 2 | TENANT ISOLATION | 8 | None found. |
| 3 | APPROVAL BEFORE CUSTOMER CONTACT | 8 | None found for the send path. |
| 4 | NO INVENTED DATA | 6 | Partial: UI wording for missing data is tested in places, not everywhere. |
| 5 | AUDIT EVERYTHING AI DOES | 6 | None found. |
| 6 | NO STUBS DISGUISED AS FEATURES | 4 | Yes: no check finds a TODO placeholder or "coming soon" box. Review only. |
| 7 | READ-ONLY BY DEFAULT | 5 | Partial: write-back is tested for the adapters that declare it. Read-only of every other call is by adapter design, not one sweeping test. |
| 8 | NEVER TRAIN / SHARE | 4 | Yes: "never trained on" is a vendor and policy matter. No test can prove it. Only the workspace boundary and logging are tested. |
| 9 | SECRETS | 7 | None for the repo and logs. Secrets in the host environment are out of scope for tests. |
| 10 | D-75 precise AI claim | 6 | Partial: quote verification is tested for extractions and citations. Each new agent needs its own forbidden-field list. |

## 1. PROOF, NOT A SCORE

Rule: every health value, risk and AI claim links to source records, values, dates and a reason.

| Check | Where | What it proves |
|---|---|---|
| DB trigger `health_snapshot_has_proof` (deferred constraint triggers `health_snapshot_proof`, `health_reason_proof`) | `prisma/migrations/20261102144442_m3_health/migration.sql` | A health snapshot with a pillar score and no EVIDENCE reason cannot be committed. A risk reason must be EVIDENCE. |
| `the database refuses a score without proof (M3 rule 2)` > `rejects a pillar score with no evidence reason (a missing-data note is not proof)`, `rejects an evidence reason with no source` | `src/modules/health/__tests__/write-snapshot.int.test.ts` | The trigger above works. Also `keeps history immutable: no edits to snapshots or reasons, no deleting the only proof`. |
| `refuses (Zod) a pillar score with no evidence reason, before touching the database`, `refuses (Zod) an evidence reason with no source` | same file | The service refuses before the database does. |
| `health reason sources` > `covers every source type the engine emits`, `says plainly when a record no longer exists, instead of a dead link` | `src/modules/health/__tests__/sources.test.ts` | Every reason type maps to a source link. |
| `refuses an agent's proposal with no proof (Rule 1)` | `src/lib/db/__tests__/m4-constraints.int.test.ts` | The database refuses a proposal without proof. |
| `every text signal's evidence carries a quote and a date (proof, not a score)` | `src/modules/signals/__tests__/rules-text.test.ts` | Text signals carry a quote and a date. |

Gap: the checks cover the data layer and the engine. No single test walks every screen and asserts a source link beside every number.

## 2. TENANT ISOLATION

Rule: every domain query is scoped by `workspaceId`; cross-tenant access is impossible by construction; tests try to break it.

| Check | Where | What it proves |
|---|---|---|
| RLS: `ENABLE` and `FORCE ROW LEVEL SECURITY` on tenant tables (156 lines mentioning `ROW LEVEL SECURITY` across migrations); runtime role `app_user` | `prisma/migrations/*/migration.sql`, e.g. `20261102082906_identity_tenancy` | The database filters by `app.workspace_id`. |
| `model registry` > `classifies every Prisma model exactly once`; `%s has workspaceId and @@unique([workspaceId, id])`; `the runtime role cannot bypass RLS` | `src/lib/db/__tests__/model-registry.int.test.ts` | Every model is tenant or global. Every tenant model has the composite key. The app role cannot bypass RLS. |
| `tenant isolation (Rule 2)` > `1. reads through A's client never return B's rows, for every [W] model`; `2. updates and deletes through A with B's ids change nothing`; `3. passing B's workspaceId to A's client throws`; `4. raw SQL as app_user without app.workspace_id sees no tenant rows (RLS)`; `4b. RLS WITH CHECK blocks writing another workspace's rows even inside A's setting`; `5. a composite-FK insert referencing B's parent from A fails`; `6. $queryRawUnsafe and $executeRawUnsafe are refused on the scoped client` | `src/lib/db/__tests__/tenant-isolation.int.test.ts` | The scoped client, RLS and composite foreign keys each block cross-tenant access. Per-milestone files `tenant-isolation-m3` to `-m12` repeat this for later models. |
| `tenant enumeration — every Server Action, Route Handler and Ask AI tool` > `Server Actions: workspace B ids never read or change B`; `Route Handlers: ...`; `Ask AI tools: workspace B ids never read B`; `discovers the surface` | `src/lib/db/__tests__/tenant-enumeration.int.test.ts` | Every action, route and Ask AI tool is attacked with another workspace's ids. |
| `scopedDb inside a tenant transaction (Q-54)` > `a nested client for another workspace is still refused` | `src/lib/db/__tests__/nested-scoped-m12.int.test.ts` | Nested clients cannot switch workspace. |
| ESLint `import boundaries` > `blocks the raw Prisma client in feature modules`; `blocks constructing PrismaClient outside src/lib/db` | `src/lib/__tests__/lint-boundaries.test.ts`, rule config in `eslint.config.mjs` | Feature code cannot import the raw client. |
| ESLint `nexaworks/raw-sql-workspace` (D-40): `raw SQL must filter by workspace (D-40)` > `flags raw SQL with no workspace filter`, `refuses the unsafe raw methods`, `refuses a prebuilt query it cannot check` | `eslint-rules/raw-sql-workspace.mjs`, `src/lib/__tests__/lint-raw-sql.test.ts` | Raw SQL without a workspace filter fails lint. |
| `M12 tenant isolation (ProductEvent)` > `A cannot read B's event`; `refuses a membership from another workspace` | `src/lib/db/__tests__/tenant-isolation-m12.int.test.ts` | The newest tenant table is covered. |

## 3. APPROVAL BEFORE CUSTOMER CONTACT

Rule: nothing is sent to a customer without approval, or an explicit auto-send setting plus all guards. Sensitive topics never auto-send.

| Check | Where | What it proves |
|---|---|---|
| ESLint `no-restricted-imports` for the customer transport; test `blocks the customer email transport everywhere except outbound dispatch` | `eslint.config.mjs`, `src/lib/__tests__/lint-boundaries.test.ts` | Only dispatch may import the transport. |
| `customer email import graph` > `only outbound/dispatch.ts imports the customer transport`; `only the customer transport imports the raw Resend call`; `the check catches every import form` | `src/modules/outbound/__tests__/import-graph.test.ts` | Same rule, checked on the real import graph. |
| `dispatch: the only way a customer email leaves` > `sending without an approved approval throws`; `a REJECTED approval cannot send`; `an approval decided by someone without approvals:decide cannot send`; `an approval at the wrong level cannot send`; `text that differs from the approved version cannot send`; `a draft with no source citations cannot send`; `dispatching twice sends once` | `src/modules/outbound/__tests__/dispatch.int.test.ts` | Dispatch refuses every send that is not approved as written. |
| `evaluateGuards` > `reports all 8 guards, and all pass on the clean baseline`; guards 1 to 8 (3-day contact window, 48-hour cross-play window, quiet hours, open HIGH/URGENT ticket, LOST account, sensitive topic, suppression, kill switch) | `src/modules/outbound/__tests__/guards.test.ts` | Each auto-send guard (spec §6J.4) is unit tested. |
| `6 · a sensitive topic never auto-sends, even when every other guard passes and the switch is on` | same file | Rule 3 sensitive-topic clause. |
| `S6: Auto-send guards integration through the play runner` > `7. Rule 3: Sensitive draft NEVER auto-sends even with auto-send on and all other guards passing`; `6. Guard: master switch off routes to human approval` | `src/modules/outbound/__tests__/auto-send.int.test.ts` | The guards hold when run through the play runner. |
| `detectSensitive` and `inbound sensitive messages never reach a send without a person` | `src/modules/outbound/__tests__/sensitive.test.ts`, `sensitive-inbox.test.ts` | Cancel, price, legal, security, complaint and escalation wording is detected. |
| `a suppressed address never sends, even when approved`; `a bounced or departed contact never receives an approved send` | `dispatch.int.test.ts` | Suppression beats approval. |

## 4. NO INVENTED DATA

Rule: missing data is shown as missing; AI answers cite what they checked; an answer with no source is not rendered; missing data never lowers a health score.

| Check | Where | What it proves |
|---|---|---|
| `Ask AI answer validation` > `an answer with no citation is not rendered`; `a citation to a record no tool returned is rejected` | `src/modules/agents/__tests__/ask-ai-validate.test.ts` | Uncited Ask AI answers are dropped. |
| `agent executor` > `an uncited answer is UNCITED: a citation to a record it was not given, or an invented number` | `src/modules/agents/__tests__/executor.int.test.ts` | Same for agent runs. |
| `citation ids and quotes` > `a citation id not in the bundle → UNCITED`; `an empty citations array fails the schema` | `src/modules/agents/__tests__/citations.test.ts` | Citations must match the records given. |
| `sentiment_share` > `no labels, or only one, is not enough data and never lowers the score` | `src/modules/health/__tests__/sentiment.test.ts` | Missing data does not lower a score. Similar cases in `components.test.ts` and `aggregate.test.ts`. |
| `recorded provider (D-19)` > `fails loudly when no recording exists instead of inventing output` | `src/lib/ai/__tests__/providers.test.ts` | The test AI transport does not invent output. |
| `missing-data helper` > `does not ask about a renewal date when there is no contract (that is shown as 'No contract on file')` | `src/modules/accounts/__tests__/missing-data.test.ts` | The "No contract on file" wording. |
| `agent executor` > `with no API key the product says it is not configured and writes no run` | `executor.int.test.ts` | No key: no fake output. |

Gap: wording of missing states on each screen is tested only where listed.

## 5. AUDIT EVERYTHING AI DOES

Rule: every agent run writes an AgentRun record with inputs, prompt version, model, output, reasoning, confidence, action, approver, outcome.

| Check | Where | What it proves |
|---|---|---|
| `agent executor` > `a SUCCEEDED run carries every audit field, and the audit log names it (Rule 5)` | `src/modules/agents/__tests__/executor.int.test.ts` | The run record is complete. |
| `model registry` > `every model that can hold AI output enforces origin = AI ⇒ agentRunId (Rule 5)` | `src/lib/db/__tests__/model-registry.int.test.ts` | Every AI-capable table has a check constraint named `*agent_run_required`. Constraints are in `prisma/migrations` (e.g. `20261102091629_m2_accounts_people`). |
| `a sentiment label without the AgentRun that produced it is rejected (Rule 5)`; `an AI-origin StakeholderRole without an agent run is rejected by the database (Rule 5)` | `src/lib/db/__tests__/tenant-isolation.int.test.ts` | The constraint rejects orphan AI rows. |
| `an AI promise without its quote, or a KEPT one without evidence, is refused by the database` | `src/lib/db/__tests__/tenant-isolation-m9.int.test.ts` | Same for promises. |
| `audit log` > `rejects UPDATE and DELETE (append-only trigger)`; `redacts secret-looking keys in before/after, recursively` | `src/lib/audit/__tests__/audit.int.test.ts`; trigger `audit_log_append_only` in `20261102082906_identity_tenancy/migration.sql` | The audit log cannot be edited. |
| `the same trigger twice gives one AgentRun and one model call`; `a crash after persist, then a retry, never duplicates the approval (sourceKey)` | `executor.int.test.ts` | Runs are idempotent. |

## 6. NO STUBS DISGUISED AS FEATURES

Rule: no TODO placeholder shipped as done; no mock data in production code paths; mocks live in tests and seed only.

| Check | Where | What it proves |
|---|---|---|
| `production env refusals hold except for the e2e build` > `refuses <name>=<value> in production, staging and mis-pointed e2e` for `AI_PROVIDER=recorded`, `EMAIL_TRANSPORT=log`, `SLACK_DELIVERY=log`, `INTEGRATIONS_TRANSPORT=fixture`, `ALLOW_FAKE_CLOCK`, `RATE_LIMIT_SCALE` | `src/lib/config/__tests__/deployment-guards.test.ts`, `src/lib/config/env.ts` | The test seams (recorded AI, log email, fixtures, fake clock) are refused in production. |
| `testSeamsAllowed` > `in a production build only with APP_ENV=e2e on a *_e2e database` | same file | Seams open only for the e2e build. |
| `refuses the recorded AI provider in production (D-19)`; `refuses the log-only email transport in production` | `src/lib/config/__tests__/env.test.ts` | Env schema refusals. |
| `M12 production build` e2e tests | `e2e/m12-production.spec.ts` | The production build runs the main screens. Not verified here whether it asserts "no placeholder text". |

Gap: nothing scans for TODO placeholders, "lorem" or "coming soon" boxes. This rule is enforced by review and by the milestone acceptance checklist only.

## 7. READ-ONLY BY DEFAULT for external systems

Rule: write-back needs an explicit per-integration, per-workspace setting.

| Check | Where | What it proves |
|---|---|---|
| `write-back gate (Rule 7)` > `is off by default and refuses, with an audit row and no approval`; `refuses a field that is not in the allowed list`; `when allowed, creates a WRITE_BACK approval; the push happens only once approved`; `approving through the approvals service re-checks the gate: switched off since → refused, audited`; `the switch is Admin-only, accepts only declared fields, and is audited with before/after` | `src/modules/integrations/__tests__/writeback.test.ts` | The gate, the field list, approval and Admin-only switch. |
| `write-back over a live transport (D-116)` > `a live transport refuses with WRITE_BACK_LIVE unset: nothing sent, audited, approval untouched`; `explicitly off behaves like unset, and the env switch is read as a strict true/false, default false` | `src/modules/integrations/__tests__/writeback-live.int.test.ts` | A second, environment-level switch for live pushes. |
| `HubSpot contract` > `write-back declares only the account owner and PATCHes hubspot_owner_id`; Salesforce and the email adapters have their own `contract.test.ts` (their write-back assertions are not verified here) | `src/modules/integrations/adapters/*/__tests__/contract.test.ts` | Each adapter declares its few writable fields. |
| `RBAC matrix (ARCHITECTURE §7.2)` | `src/lib/auth/__tests__/rbac-matrix.test.ts` | Who may change the setting. |
| `an overdue step on OUR side never writes to the customer: the owner gets a Task instead` | `src/modules/agents/__tests__/onboarding-manager.int.test.ts` | Agents do not write outward on their own. |

Gap: "every other integration call is a read" holds by adapter design. No single sweeping test proves it.

## 8. NEVER TRAIN / SHARE

Rule: customer data never trains shared models and never leaves the workspace boundary beyond the AI call for that workspace.

| Check | Where | What it proves |
|---|---|---|
| `agent context bundles never cross the workspace boundary (Rule 8)` > `every registered agent is either covered or explicitly listed as not covered`; `A's agents build bundles from A's records only`; `Ask AI retrieval with tool steps naming B's ids returns no B record` | `src/lib/ai/__tests__/bundle-isolation.int.test.ts` | Prompt context for one workspace holds only that workspace's records. |
| `agent runs log no AI content` > `neither the input records nor the model output appear in any log line` | `src/modules/agents/__tests__/ai-logging.int.test.ts` | Logs do not carry customer content. |
| `log redaction (M12 A11)` | `src/lib/__tests__/log-redaction.test.ts` | Log fields are redacted. |
| Tenant isolation checks under rule 2 | see rule 2 | Same boundary for stored data. |

Gap: that the AI vendor does not train on API data is a vendor term, not a code behaviour. No test checks it.

## 9. SECRETS

Rule: never print, log, commit or echo a secret. `.env.example` lists names only.

| Check | Where | What it proves |
|---|---|---|
| `scripts/check-secrets.ts`, run by `pnpm lint`; patterns in `scripts/secret-patterns.ts` | `package.json` (`lint`) | Tracked and untracked files are scanned. Prints file, line and rule, never the value. |
| `secret scanner` > `reports location and rule, never the matched text`; `accepts an env example with names only`; `rejects an env example that carries a value` | `scripts/__tests__/secret-patterns.test.ts` | Scanner behaviour. More cases in `secret-patterns-m5/m6/m9/m12.test.ts` (e.g. `flags a hard-coded secret fallback after ??`). |
| `scripts/check-secrets-history.ts` | `scripts/check-secrets-history.ts` | Scans every blob and commit message in history. Not in `pnpm lint`; CI runs it on every push (`.github/workflows/ci.yml`, step `pnpm exec tsx scripts/check-secrets-history.ts`). Results: D-172. |
| `env schema` > `names the missing variable without echoing any value` | `src/lib/config/__tests__/env.test.ts` | Config errors never echo values. |
| `log redaction (M12 A11)` > `scrubs key-shaped and bearer values that appear inside free-text strings` | `src/lib/__tests__/log-redaction.test.ts` | Secret-shaped strings are scrubbed from logs. |
| `audit log` > `redacts secret-looking keys in before/after, recursively` | `src/lib/audit/__tests__/audit.int.test.ts` | Audit rows do not store secrets. |
| `field encryption (AES-256-GCM)` > `round-trips text and tags ciphertext with the key id`; `detects tampering` | `src/lib/crypto/__tests__/crypto.test.ts` | Stored credentials are encrypted. |

## 10. D-75 precise AI claim

Rule: no LLM produces a health, risk, forecast or money number. LLM extractions feed components only when every verbatim quote is verified. Numbers in narrative must appear in a cited record.

| Check | Where | What it proves |
|---|---|---|
| `health and signals use no AI` > `src/modules/<mod> never imports the AI provider`; `the check itself catches an AI import` | `src/modules/health/__tests__/health-no-ai.test.ts` | Health and signals code cannot call the model. |
| `forbidden-numeric overwrite` > `overwrites agent-supplied confidence and money with the deterministic values`; `removes a forbidden field when code has no value for it (never keeps the model's)` | `src/modules/agents/__tests__/forbidden-numeric.test.ts` | Model-supplied numbers are replaced by code or dropped. |
| `forbidden numeric fields` > `lists exactly confidence, arrAtRisk and expansionEstimate`; `drops a figure code has no value for (no ARR on file: none is invented)` | `src/modules/agents/__tests__/forbidden-numeric-m7.test.ts` | Renewal and expansion figures come from records. |
| `citation ids and quotes` > `a quote that is not a verbatim substring → UNCITED`; `numbers in narrative text` > `an invented count fails` | `src/modules/agents/__tests__/citations.test.ts` | Quotes must be verbatim; numbers must be in a cited record. |
| `Ask AI answer validation` > `a number absent from every cited record is rejected (UNCITED)`; `a quote must be verbatim from the cited record` | `src/modules/agents/__tests__/ask-ai-validate.test.ts` | Same for Ask AI. |
| `a paraphrased quote never reaches the rules: nothing fires from an invented extraction`; `reads each chunk once, verifies quotes against their own chunk, and records the chunk index` | `src/modules/signals/__tests__/rules-text.test.ts`, `src/modules/agents/__tests__/watcher-m9.int.test.ts` | Unverified extraction quotes are discarded before they feed signals. |

Gap: the forbidden-field list is per agent definition (`forbiddenNumericFields`). A new agent that forgets it is caught only by review. The golden replay tests (`src/modules/agents/__tests__/golden-replay*.test.ts`) cover the existing agents.
