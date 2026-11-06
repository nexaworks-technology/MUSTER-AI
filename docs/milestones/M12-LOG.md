# M12 log — Hardening & Deploy

> Session A draft; Sessions B and C append.

## Deferral sweep (A1)

Source: every `docs/milestones/M1-LOG.md` through `M11-LOG.md`, cross-read with `docs/QUESTIONS.md` and `docs/milestones/M12.md` §2. Commit hashes cited in older logs are the OLD hashes from before the M12 A2 history rewrite; see `docs/HISTORY_REWRITE_MAP.md`. Items that an earlier milestone resolved by its own later log are not repeated, except the three flagged "resolved before M12" that the logs left looking open.

| # | Item | Origin (milestone + log section) | Target in M12 | Status |
|---|---|---|---|---|
| 1 | Docker #16: run `docker compose up -d postgres redis minio`, record output in M1-LOG; verify the unverified compose file, MinIO image tag (`chainguard/minio:latest`), init script, Postgres 14 vs 16 drift (D-31) | M1 (Acceptance #16, Deferrals, Known risks 1 and 5); carried in M2-M11 logs; M11 hand-off 2 | Session C, C2 (on a host with Docker; M12 §6 #23). Stays PARTIAL with reason if no Docker | open |
| 2 | Live Google sign-in check (Auth.js Google provider) | M1 Deferrals | Session C, C3 (needs Google OAuth credentials) | open |
| 3 | Live Resend send through `outbound.dispatch` to a test address, plus delivery webhook (Svix/Resend signature) verified live | M1 Deferrals; M4 Deferrals; M8 acceptance #17 and Homing of Deferrals | Session C, C3 (M12 §6 #21); DEFERRED if no `RESEND_API_KEY` | open |
| 4 | Server Action / Route Handler / Ask tool tenant enumeration test (Q-50); M11 inventory: `askAction`, `decideCardAction`, `generateReportAction`, `tuneRuleAction`, `killRuleAction`, `saveVoiceDictationAction`, `saveWorkspaceProfileAction`, `POST /api/ask/files`, the 12 Ask AI tools, plus portal, webhook, Slack interactivity, usage API routes | M1 Deferrals; M5 Deferrals (Q-50); M11 hand-off 8 | Session A, A6 | open |
| 5 | Upload safety in production: malware scanner configured for prod (files stay PENDING until one exists, D-46); boot check refuses prod without one; also covers ASK_ATTACHMENT (Q-18) | M1 Deferrals; M2 Deferrals and Known risks; M11 (Q-18 status) | Session B, B6 (M12 §6 #15) | open |
| 6 | Production-build e2e (`next start`), D-37 retired; staging smoke | M1 Deferrals; M2 Deferrals (D-37, carried) | Session B, B7 (production-build e2e); staging smoke part in Session C, C2 (M12 §6 #14) | open |
| 7 | Q-47: e2e web server on the recorded AI provider (`playwright.config.ts` edit) or close as not needed | M4 Deferrals (Q-47) | Session B, B7 (founder decision recorded in QUESTIONS.md; M12 §6 #25) | open |
| 8 | Nested `scopedDb` reads inside `$tenantTransaction` callbacks: find and fix every call, add lint rule or test (Q-54) | M5 Deferrals and Session B questions (Q-54) | Session A, A5 (M12 §6 #24) | open |
| 9 | Live sandbox checks, read-only, HubSpot, Salesforce, Stripe, Chargebee, Slack: connect, sync twice, webhook/signature verification (fixture-verified only) | M5 acceptance #16 and per-provider table; M5 Deferrals; M7 Deferrals (D-116) | Session C, C3 (M12 §6 #20); DEFERRED if no credentials | open |
| 10 | Live write-back: with `WRITE_BACK_LIVE=true` on a sandbox HubSpot/Salesforce, one approved owner write-back pushes and is audited; unset, refused (D-116). Also live Gmail/Graph "draft in mailbox" write-back, refused without the env | M5 (D2 founder decision); M6 S5; M7 Deferrals; M9 B7 | Session C, C3 (M12 §6 #22); DEFERRED if no sandbox | open |
| 11 | Live Usage API with Segment's webhook destination (HMAC-SHA1 `x-signature` scheme untested against Segment), Mixpanel (`time` zone reading), Amplitude (segmentation response shape, `seriesMeta`): expected first-live fixes | M6 acceptance #15, provider table, Deferrals | Session C, C3 (M12 §6 #20); DEFERRED if no credentials | open |
| 12 | Live Zendesk, Freshdesk (Q-82 shared-secret header), Gmail, Microsoft Graph checks: connect, sync twice, signature verification; fixtures are authored from docs, not captured | M9 acceptance #14, connector table, Deferrals | Session C, C3 (M12 §6 #20); DEFERRED if no sandbox credentials | open |
| 13 | Push subscriptions: Gmail Cloud Pub/Sub and Microsoft Graph change notifications vs current polling, idempotency | M9 Connectors Session close (Deferrals homed). Note: M9-LOG labels this "Q-81"; QUESTIONS.md Q-81 is the UTC trigger item (row below) | Session C, C3 (M12 §6 #26); DEFERRED with documented operational architecture if no sandbox | open |
| 14 | Live sandbox calendar/transcript sync (M10 adapters) | M10 acceptance #14; M11 hand-off 1 | Session C, C3; DEFERRED if no sandbox credentials | open |
| 15 | Live model checks: `pnpm eval` extraction, Health Analyst, Outreach, Leader Reporter prompt; live Ask AI eval on a fixed question set (prompts unproven against a live model; precision of weak extraction kinds unmeasured) | M4 acceptance #15 and Known risks; M9 acceptance #5; M11 acceptance #16 and hand-off 1 | Session C, C3 (needs `ANTHROPIC_API_KEY`); DEFERRED if absent | open |
| 16 | PDF extraction (`unpdf`) on real customer contracts | M11 hand-off 1 | Session C, C3 (needs real sample PDFs); else pilot handover | open |
| 17 | Q-81: M3 stamp triggers (`contact_status_changed_at`, `ticket_escalated_at`) store server-local time; UTC migration following `20261107110000` pattern, tests across server time zones (also explains Q-77 `inputsHash` instability) | M9 Session A/B (Q-81 in QUESTIONS.md); M9-LOG "Session B - deferrals"; M11 hand-off 3 | Session A, A4 (M12 §6 #27) | open |
| 18 | Git history scrub of historical DB credentials from commit `712d626` before any push or share (Q-78) | M9 Slice 0, Q-78 outcome and Deferrals homed; M12 §2 | RESOLVED in M12 A2 (history rewritten, scan across all commits; D-172; see `docs/HISTORY_REWRITE_MAP.md`) | resolved |
| 19 | Removed hard-coded survey secret fallback still present in history; rotate anything that relied on it and scrub | M11 hand-off 4 | RESOLVED in M12 A2 (literal replaced by `$REMOVED_SURVEY_FALLBACK`, D-172). Rotation of anything that relied on it is covered by Session A A10 (survey token rework) and the no-push-before-scrub rule | resolved |
| 20 | Migration-history reconciliation: `20261106120000_m8_campaigns` applied on dev but missing from repo; M8 (`20261106121000_m8_campaigns`) and M10 migrations edited after apply; `migrate diff` drift (`Campaign_approvalId_key`, `OutboundMessage_workspaceId_campaignId_idx`, `updatedAt` defaults on Campaign, CampaignRecipient, VoiceSample); `migrate reset` drops runtime-role grants, so re-apply `docker/postgres/grants.sql` plus ALL TABLES/SEQUENCES/FUNCTIONS grants to `app_user` | M11 hand-off 5 | Session A, A3 | open |
| 21 | IP-level rate limits and body-size caps on public/upload endpoints: `POST /api/ask/files` (25 MB), portal `/portal/[token]`, survey submit, webhook routes, `askAction` (up to 7 model calls per question); IP-level limit on 401s and streaming body cap (M6 review N3) | M6 Post-M6 review fixes ("Not done, by design"); M11 hand-off 6 | Session A, A9 (rate limits + streaming body caps); portal/survey part also A10 | open |
| 22 | Survey/portal attack pass and the survey intake public route: emailed link points at hard-coded `https://app.nexaworks.com/portal/surveys?token=...` (not APP_URL), no page built; token has no expiry, non-constant-time signature compare, unvalidated payload (M10 acceptance #7/#8 proven at service level only) | M10 acceptance #7/#8 (found later; recorded in the M10 Errata appended in M12); M11 lint refactor of survey link secret | Session A, A10 | open |
| 23 | e2e isolation: shared `_test` DB never reset; append-only renewal outcomes and frozen checkpoints; specs must use accounts outside other specs' assertions; consider per-run DB reset in global setup | M11 hand-off 7 and Session 2 incidents | Session B, B7 | open |
| 24 | Performance pass: heaviest queries (`reports` adoption 31 queries per generation, `loadLedger`, `evaluateLongCheckpoints`, Ask AI retrieval reruns in `buildContext`); nightly duration at scale (linear in chunks, 60 accounts took about 1.0-1.4 s); real-time signal Today rebuild is workspace-wide | M11 hand-off 9; M3 Known risks; M5 Known risks | Session B, B3 (M12 §6 #11, #12) | open |
| 25 | 2,000-account nightly jobs: `outcomes.checkpoint` (d7, revenue, d30/d90), `reports.weeklyDigest` (Monday cron), snapshot generation for the four digest reports | M11 hand-off 10 | Session B, B3 | open |
| 26 | Pilot instrumentation hooks: Ask AI questions/answers (status, citations, proposals decided), ledger saves per period, cries-wolf rule changes (`signal_rule.updated`), digest delivered/failed | M11 hand-off 11 | Session B, B5 (M12 §6 #16) | open |
| 27 | Setup guide must state that a customer sending usage only through our Usage API keeps no raw event history with us (Q-33) | M6 Deferrals (and M12 §4 step 16) | Session B, B9 | open |
| 28 | Q-83: agent roster is 15 registered vs ARCHITECTURE §6.2's 14 (D-30 cap comment) | M11 Decisions and questions (open) | Session B, B9 (reconcile docs) plus founder decision; otherwise pilot handover open decision | open |
| 29 | Q-84: d7 checkpoint due date uses raw milliseconds, not workspace business dates (D-161) | M11 Decisions and questions (open) | Pilot handover: known limit; founder decision whether to fix | open |
| 30 | Q-85: seed gap, the 12 past renewals never modelled as `Renewal` records, so no past RenewalOutcome or health history in seed | M11 Session 2 (recorded) | Pilot handover: seed-only, no production code path; note in docs if the 2,000-account generator makes it visible | open |
| 31 | Engagement pillar meeting component (`last_meeting`) activation: needs a new health model version plus back-test calibration (D-154) | M10 Session 1, Decision 1 standing note | Phase 2: scoring model change is a new feature, not hardening (M12 §3) | open |
| 32 | Recording a renewal outcome by hand (only contract records detect it today) | M7 Deferrals | Phase 2: new feature (M12 §3); pilot handover limit | open |
| 33 | Q-67 per-event dedupe / stored identities; Q-66 people-level Amplitude rows | M6 Deferrals | Phase 2: warehouse scope | open |
| 34 | Ask AI usage cost/latency: up to 6 planner calls plus one deep answer; planner tokens recorded on AskMessage, not summed into AgentRun | M11 Known risks | Session B, B4/B5 (observability and cost visibility), else pilot handover known risk | open |
| 35 | Resolved before M12, listed for completeness: tagged `$queryRaw` lint rule (D-40) | M1 Deferrals; M2 Deferrals | RESOLVED in M3 (`eslint-rules/raw-sql-workspace.mjs`, `lint-raw-sql.test.ts`) | resolved |
| 36 | Resolved before M12, listed for completeness: Slack card copy "read-only" (Q-56) | M5 Deferrals | RESOLVED in M6 slice 0 (QUESTIONS.md Q-56 Closed; confirmed in `settings/integrations/page.tsx` check) | resolved |
| 37 | Resolved before M12, listed for completeness: signals list category filter for CALLS_EMAIL / PROMISES (Q-76) | M9 Session A | RESOLVED (CALLS_EMAIL label present in `signals/schemas.ts`); verify PROMISES during A6 if touched | resolved |

**Row count: 37** (5 already resolved, 32 open).

---

## Session A — Security & correctness (2026-11-06)

Founder go: D1–D8 at the recommended defaults (D5: Fly.io, needed at Session C; D9 name/pricing never invented); `git-filter-repo` approved as a machine tool. All commit hashes below are on the **final** rewritten history.

### What was built

| Slice | Model | Commit | What | Evidence |
|---|---|---|---|---|
| Scanner (A2 pre) | Opus | `d81e930` | `scripts/check-secrets-history.ts`: every blob reachable from every ref plus every commit/tag message, the same patterns as `check-secrets.ts`, plus known leaked literals from a local, never-committed file; prints ids, never values. New rule `secret-fallback-default`. The URL rule no longer flags `${…}` template passwords. | RED `m12-evidence/a2-red.txt`; 22 scanner tests |
| A2 History scrub | **Opus** | `dc792cf` | `git filter-repo` 2.47.0 on a fresh clone in two ordered passes. Replaced: the two rotated Q-78 DB passwords, the survey fallback string (incl. M11-LOG), and two fake fixture literals shaped like tokens. The M9 scanner test keeps a detectable fake value. D-172. | before: 18 findings (`a2-history-scan-before.txt`); after: **0** (`a2-history-scan-after.txt`); raw sweep of 5,461 objects 0; fsck clean |
| A1 Deferral sweep | Sonnet | `80ecb6e` | 37 deferral rows, every one placed (A/B/C/Phase 2/pilot). Errata appended to M10-LOG (Brightwell 64.87/WATCH/40 per Q-86; survey intake PASS was service-level only) and M11-LOG (survey literal scrubbed). | M12-LOG §Deferral sweep |
| A3 Migrations | **Opus** | `fe55681` | The folder (37) is the source of truth. `migrate deploy` from an empty scratch database applies all 37; dev and test hold exactly the 37 with matching checksums; `schema.prisma` now declares what the M8 migrations created, so `migrate diff` is empty. No applied migration edited; the M8/M10 after-apply edits are stated plainly in D-173. | `m12-evidence/a3-migrations-from-zero.txt` |
| A4 Q-81 UTC | Sonnet | `724f74a` | `contact_status_changed_at`, `ticket_escalated_at` and (found in the audit) `ticket_priority_history` stamp `now() AT TIME ZONE 'UTC'`. New migration; none edited. | RED (5.5 h / 8 h offsets) `a4-red.txt`; tests under Asia/Kolkata + America/Los_Angeles |
| A5 Q-54 | **Opus** | `ab56b6c` | Root fix in `scopedDb`: any same-workspace scoped operation while a tenant transaction is open re-issues on that transaction's client (it used another pooled connection with no workspace set, so RLS silently hid rows); another workspace is still refused. D-174. | RED 4/5 `a5-red.txt`; audit `a5-nested-audit.txt` (0 lexical sites); targeted regression 118 files / 1,338 tests |
| A7 RBAC | Sonnet | `cb76e02` | §7.2 written independently and asserted against `can()` for every role × permission (book cells across OWN/TEAM/ALL). Revenue redaction proven across accounts, billing, renewals, revenue view, report snapshots, ledger and Ask AI tools. **No mismatch, no gap.** | 100 tests; `a7-red.txt` |
| A6 Tenant enumeration | **Opus** | `72dca07` | Discovered at runtime: **90** Server Actions, **16** route-handler entries (2 Auth.js methods exempt with reason), **12** Ask AI tools. Each called with a real workspace-A session and workspace-B ids in 4 input shapes; B's rows must stay byte-identical (hash over all [W] tables) and no B id or text may be returned. All green; Q-50 resolved. | `tenant-enumeration.int.test.ts` |
| A8 Headers/CSP/cookies | Sonnet | `8b6eb70` | `src/proxy.ts`: per-request nonce CSP (strict-dynamic, `frame-ancestors 'none'`), HSTS (production), nosniff, Referrer-Policy, X-Frame-Options DENY, Permissions-Policy; Auth.js cookies HttpOnly/SameSite=Lax/Secure with `__Secure-`/`__Host-` prefixes in production. **Found in the browser:** Next's dev server injects nonce-less `<style>` (66 violations), so development alone allows inline styles. Production nonce-only is **to be proven in B7's production-build e2e**. D-175. | 16 tests; `a8-red.txt`; dev browser check |
| A9 Rate limits & body caps | **Opus** | `7d43b56` | Repeated-401 IP block (20 per 10 min → 429). Limits on sign-in (IP, email), invitation accept, webhooks, portal, survey, Ask AI and uploads. Every body read through a streaming cap that stops a chunked oversize request regardless of Content-Length (the email webhook had **no** cap). D-176. | RED `a9-red.txt`; 13 tests proving refusals through the real routes and actions |
| A10 Portal/survey attack pass | **Opus** | `e5d8e19` | **M10 bug fixed:** public `/s/[token]` page and action (survey intake was service-level only; the emailed link pointed at a hard-coded host that never existed). Token v2: domain-separated key, constant-time check, Zod payload, 30-day expiry, one answer per token. Grep audit of every signing site found **one more hard-coded fallback**, the M8 unsubscribe key, which was removed; new scanner rule `secret-constant-literal` (shipped code only). Portal penetration suite re-run green. D-177. | RED `a10-red.txt`; 9 survey attack tests; scanner tests |
| A11 Logs, CI, audit | Sonnet | `d112e0c` | Deep log redaction (tokens, credentials, cookies, email bodies, AI content, key-shaped strings, Error causes). `.github/workflows/ci.yml` runs gate + history scan + advisory audit (unverified until a remote exists). `pnpm audit`: 1 high (deepmerge-ts via Prisma config tooling, transitive), 1 moderate dev-only (minimatch via typescript-eslint); **nothing upgraded**. | `a11-red.txt`; `a11-audit.txt` |
| A12 Bundle isolation + SECURITY.md | Sonnet | `483e739`, `e2f1e42` | Every agent's prepared bundle holds only its workspace's records, and forged B ids never reach a bundle or prompt (14 agents + Ask AI retrieval; a new agent must add a fixture). `docs/SECURITY.md` makes no certificate claims. Q-19 records Anthropic's public commercial terms read 2026-11-06 (commercial-terms page; privacy-center retention article). The founder's own account terms are **not** verified. | 3 isolation tests |
| Second scrub pass | Opus | `f882f4d` | Founder-approved: the M8 unsubscribe fallback literal removed from all history (D-178). Hash map regenerated: original → after A2 → final for the 220 pre-M12 commits, and before → final for the 13 M12 commits made between passes. | history scan with all 4 known values: 233 commits, 2,658 blobs, **0 findings**; raw sweep 0; fsck clean (`a10-history-scan-after-second-pass.txt`) |

**History rewrite facts:**
- **Backups (untouched):** the original is at `/Users/sahil/customer-sucesss-platform-backup-pre-scrub-2026-11-06.git`; the after-A2 state is at `/Users/sahil/customer-sucesss-platform-backup-after-a2-2026-11-06.git`.
- **Not in the repo:** the replacement expressions and the known values live only in the session scratchpad.
- **Nothing pushed or shared;** the repo has no remote.
- **Old hashes:** M1–M11 logs keep citing the original hashes; use `docs/HISTORY_REWRITE_MAP.md`.

### Pre-M12 test changes

None. The M9 scanner test's fixture value was changed **only through the history rewrite** (D-172: the leaked password became a fake, still-detectable value). It was not edited as a file, and it passes at every commit.

### The one mid-milestone full `pnpm test`

| Run | Files | Tests | Result |
|---|---|---|---|
| M11 close baseline | 284 | 2,651 | green |
| **M12 Session A mid-run** (on the final history) | 297 | 2,815 | **1 failed**, 296 files / 2,814 tests passed (302 s) |

**The failure, read on its own:** `src/modules/agents/__tests__/adoption-coach.int.test.ts` › "a number the model invents is UNCITED" fails deterministically (3 of 3 isolated reruns).
- **Cause:** the test builds usage history relative to the **real current date**. On 2026-11-06 the bundle legitimately contains `"lastUsed": "Nov 4, 2026"`, `"date": "Nov 5, 2026"` and `"featuresInPlan": 5` (shown by a temporary untracked debug copy, since deleted). So the "invented" numbers 4 and 5 really are in cited records, and the numbers rule correctly accepts them.
- **Not caused by M12:** the same test fails on M11's final code (`2496ac5`, run in a temporary worktree).
- **Status: STOPPED, not fixed.** The fix is a pre-M12 test edit (invented numbers that cannot appear in any date), which needs your approval under the standing rules. No fix batch was spent.

### Findings and decisions for the founder

1. **Approve the adoption-coach test fix** (choose non-colliding invented numbers). It is date-sensitive and fails on some calendar days; it isn't an M12 regression.
2. **Dependency advisories (A11):** deepmerge-ts (high, transitive via Prisma's config tooling) and minimatch (moderate, dev-only). Recommendation: a pnpm `overrides` entry for deepmerge-ts ≥ 8.0.0 if Prisma does not ship a fix first, and accept minimatch as dev-only until a typescript-eslint bump. Nothing upgraded without your approval.
3. **ARCHITECTURE §7.2** has no rows for `data:import` (Admin, CS Leader; D-46) and `workspace:manageSettings` (Admin). The code matches its decisions; the doc should name them (B9).
4. **Q-19:** only the public Anthropic terms are recorded. Your own account terms (ZDR, DPA, retention settings) need you (Session C / pilot).
5. **The CSP in production** is nonce-only on paper and in unit tests, but not yet in a real browser. B7's production-build e2e must include a no-CSP-violations check.
6. **M9-LOG's "Q-81" for push subscriptions** was a mislabel; push stays C3 (recorded in the Q-81 resolution row).

### State summary for Session B

- **HEAD** `f882f4d` on the final rewritten history; tree clean; no remote.
- **Next slices:** B1–B9 as planned (export, delete/purge, 2,000-account performance, observability, pilot metrics, malware scanner, D3/D4 production-build e2e + isolation + CSP browser check + Q-47 closure, setup e2e + m12-hardening spec, docs).
- **Economics:** the one mid-milestone full run is **used**; no fix batch spent. The close is still one full e2e (production build) then one full gate.
- **Carried into B and C:**
  - founder decisions 1 and 2;
  - B7 must prove the production CSP;
  - the email webhook parses JSON without Zod (found in A9, out of scope there; B-session fix candidate);
  - the 2,000-account run is on this machine and labelled local.
- **Dev tools added:** `scripts/check-secrets-history.ts` (CI + manual, `--known` locally only); `git-filter-repo` 2.47.0 at `~/.local/share/git-filter-repo-2.47.0`.
