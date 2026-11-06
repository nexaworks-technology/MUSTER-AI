# M12 e2e harness fix and design follow-ups: log (2026-11-06)

This was the founder-approved scope.
- Product behaviour is unchanged apart from F1–F3.
- No test assertion was edited, weakened or deleted, and no spec file moved.
- No full gate was run here; Session C's C4 close runs it.

## H1 — AI-off e2e run (fixes M4/M9)

- **Cause:**
  - The main e2e app server replays recorded AI (Q-47, D-182), so M4's `ai-not-configured` and M9's "AI is not switched on" states could never render.
  - Both suites are serial and were written for an app with no AI provider. Later tests depend on earlier ones: M4's audit test reads the send that its check-in test approves.
  - So whole suites are routed, not single tests.
- **Built** (`playwright.aioff.config.ts`, `e2e/support/harness.ts`):
  - **Routing:** `AI_OFF_SUITES` matches the two describe titles. The main config's projects exclude them with `grepInvert`; the AI-off config's one project selects them with `grep`.
  - **Project name:** it is `desktop`, because both suites skip any other project. Playwright needs unique project names per config, hence a second config file rather than a second project.
  - **Own build and server:** a production build in `.next-e2e-aioff`, served on :3101 with queue prefix `nexaworks-e2e-aioff`.
  - **Not configured:** the app server has `AI_PROVIDER=anthropic` with an empty key, which is exactly "not configured".
  - **Shared server builder:** both configs use `e2eWebServers()`, defined in `playwright.config.ts`. Two pre-M12 tests (`business-clock`, `nightly-schedules`) read that file's text, and still pass (8/8).
- **Database:** same `nexaworks_e2e`, because the runs are provably sequential.
  - `pnpm test:e2e` is now `scripts/e2e.ts`, which runs the main config and then the AI-off config with `spawnSync`, one after the other.
  - Each run's global setup recreates the database.
  - A separate `nexaworks_e2e_aioff` was not used: the D-182 seam guard requires database names ending in `_e2e`.
- **Found while fixing:** the "AI-off" server still counted as configured, because the developer's `.env` holds a real `ANTHROPIC_API_KEY`. The runner loads it, and Next loads `.env` itself. The same key had reached the main e2e worker, where only an unset model name stopped live calls. `ANTHROPIC_API_KEY` is now blanked for every e2e server, worker and spawned script, so e2e can never reach a live model.

## H2 — explicit environment for spawned scripts (fixes the M11 digest)

- **Cause:** `runScript` passed the Playwright process's environment, so scripts enqueued on the default prefix (`nexaworks`, the dev queue). A running `pnpm dev` worker took the job and worked against the dev database, and the digest never reached the e2e database.
- **Built:** `e2eScriptEnv()` in `e2e/support/m4.ts`. Every `runScript` now gets:
  - the `_e2e` database (refused otherwise);
  - `AI_PROVIDER=recorded`, no key, and `NODE_ENV=development`;
  - queue prefix **`nexaworks-e2e-scripts`**.
  
  Callers still choose the recordings directory. Global setup clears the scripts' prefix each run.
- **Deviation from the brief, which named `nexaworks-e2e` (D-186):**
  - On `nexaworks-e2e`, the long-running e2e worker (AI off by design) competes for the scripts' jobs.
  - Observed earlier today: with the scripts on that prefix, the digest run was stored **FAILED `NOT_CONFIGURED`**.
  - The scripts run their own in-process workers, so they need a prefix where nothing else listens. Before B7 they implicitly had one (`nexaworks-test`).
  - The jobs still land only in an e2e queue and the e2e database.

**Proof**, taken with `pnpm dev` and its worker running (pid 61722, `tsx watch … src/worker/index.ts`):

| Check | Before | After |
|---|---|---|
| Dev queue `nexaworks:reports:manual-*` jobs | 10 | 10 (unchanged) |
| Dev DB `leader-reporter` AgentRuns | 1 | 1 (unchanged) |
| `nexaworks-e2e-scripts:reports:manual-*` | (cleared by global setup) | 2 jobs, created 15:40:35 and 15:40:45 (this run) |
| `nexaworks-e2e:reports:manual-*` | — | 2 jobs from 15:21 (my earlier manual probe), none from this run |
| e2e DB `leader-reporter` AgentRun | — | `SUCCEEDED · weekly-digest` |
| M11 "Weekly digest shows cited sentences and no money" | failed | passed |

## H3 — verification (production build, `pnpm dev` + worker running throughout)

| Run | Specs | Result |
|---|---|---|
| Fix batch 1 (H1 + H2) | m4, m9, m11, all 11 a11y specs, m1, m8, m6, m7, m12-production, m12-setup-and-data | Main run: **65 passed**, 39 skipped (mobile, desktop-only flows). AI-off run: **2 failed**, the `.env` API key leak above |
| Fix batch 2 (blank API key) | same set | Main run: **65 passed**, 39 skipped, 0 failed. AI-off run: **17 passed**, 0 failed |
| Proof run | m11 via the main config alone | 10 passed |

- **M4 and M9:** all 8 + 9 tests pass in the AI-off run, including the **11 previously blocked**. Those are M4's four after the check-in, and M9's seven after the Inbox test.
- **a11y suite:** 13 specs × 2 viewports, all green.
- **Production build:** built twice per run (`.next-e2e`, `.next-e2e-aioff`).
- **Failures:** none was product logic. Both batches were harness.

## F1–F3 (product changes, as approved)

- **F1 — current route highlighted.**
  - The new client component `src/components/app/nav-link.tsx` (`usePathname`) wraps `next/link`.
  - **Matching:** exact for `/`; otherwise `pathname === href` or a sub-path.
  - **Active state:** `aria-current="page"` plus tokens: the accent tint in the sidebar, and the Account 360 underline classes on the Settings tabs.
  - **Unchanged:** inactive classes, link text, `href`s and wrappers (`nav aria-label`, `ul`, `li`).
  - **Where:** used in `src/app/(app)/layout.tsx` and `src/app/(app)/settings/layout.tsx`.
  - No e2e selector depends on these links lacking `aria-current`; m1's main-nav check reads text only.
  - Evidence: `docs/milestones/m12-harness-fix/02-today.png`, `20-settings-users.png`.
- **F2 — unsubscribe title.** The page sets `title: "Unsubscribe"` and the root template adds `PRODUCT_NAME`.
  - Before: `<title>Unsubscribe | NexaWorks</title>`. After: `<title>Unsubscribe · NexaWorks AI CSM</title>`, verified with curl on the dev server.
  - No test asserted the old title.
- **F3 — bounced recipient.** `BOUNCED: "danger"` was added to `RECIPIENT_VARIANTS` in `src/app/(app)/campaigns/[id]/page.tsx`; before, it fell back to warning. The text is unchanged. m8 and a11y-m8 pass.
  - Noticed, not changed: the stats card "Failed / Bounced" counts only `FAILED` (`src/modules/campaigns/service.ts:96`).

## F4 — `/meetings/qbr/new`: investigation only, nothing changed

- **What it renders** (`src/app/(app)/meetings/qbr/new/page.tsx`, 81 lines, server component):
  - Heading "Generate Executive Business Review (QBR)".
  - A "Review Configuration" card: an account select (`qbr-account-select`) and a period input (`qbr-period-input`, default "Q3 2026").
  - Two static panels: "Locked Metrics (Read-only)" with *"Pick an account and generate review to compute locked metrics from database records."*, and "Narrative Editor" with *"Text edits only; digits outside date patterns will be rejected by placeholder validator."*
  - Its only query lists non-LOST accounts. There is no permission check, and `resolveWorkspaceContext(...)!` throws rather than returning a 404 for a user without a workspace.
- **Does submitting create a record? No.**
  - There is no `<form>`, action, `onSubmit` or button.
  - The inputs have no `name` and are uncontrolled.
  - Nothing on the page can create or change anything.
- **Where it is linked:** nowhere in the product.
  - The sidebar entry "Meetings & QBRs" is `href: null` in `src/config/features.ts:33`, so it is hidden.
  - It is referenced only by `e2e/m10-meetings-qbr-portal.spec.ts:27-34` (asserts the heading, both inputs, the period default and the metrics panel), `e2e/a11y-m10.spec.ts:9,21`, and docs (M10.md:28, M10-LOG.md:82, M12-DESIGN-LOG.md D-Q4).
  - Nothing imports from the page.
- **What hiding or removing it would touch:**
  - **Hiding:** nothing; it is already unlinked.
  - **Removing the route:** two e2e tests that assert it exists (founder approval needed to edit them), plus the docs entries. No unit or integration test, and no import, depends on it.
- **The real QBR flow is backend-only:**
  - `generateQbr` (`src/modules/qbr/service.ts:60`): locked metrics, an audited agent run (`runAgent`, `QBR_NARRATIVE`), validated narrative blocks, then a `Document` of kind QBR.
  - `updateQbrNarrative` (:225), `lockQbrDocument` (:262; outbox `business_review.followup`, which wakes the Business Review Follow-up play), and `exportQbrPdf` (:326).
  - Locked QBRs appear in the customer portal.
  - No page, server action or API route calls these functions; only `scripts/demo-m10-run.ts` and tests do. A user cannot create a QBR in the product today.
- **Read on Rule 6: yes, this is a stub presented as a feature.**
  - M10-LOG lists "UI at `/meetings/qbr/new`" as delivered, and two e2e tests lock in the placeholder panels.
  - Options for the founder:
    - (1) wire the page to `generateQbr` → editor → lock → export;
    - (2) remove the route, approving edits to the two e2e tests and the docs;
    - (3) leave it unlinked, as a known Rule 6 violation.

## Files

- **Harness:**
  - `playwright.config.ts`;
  - `playwright.aioff.config.ts` (new);
  - `e2e/support/harness.ts` (new);
  - `e2e/support/m4.ts` (`e2eScriptEnv`, `runScript`);
  - `e2e/global-setup.ts`;
  - `scripts/e2e.ts` (new);
  - `package.json` (`test:e2e`);
  - `.gitignore`, `eslint.config.mjs`, `.prettierignore` (`.next-e2e-aioff`).
- **Product:** `src/components/app/nav-link.tsx` (new), `src/app/(app)/layout.tsx`, `src/app/(app)/settings/layout.tsx`, `src/app/unsubscribe/page.tsx`, `src/app/(app)/campaigns/[id]/page.tsx`.
- **Docs:** CLAUDE.md (E2E command), DECISIONS D-186, this log, `docs/milestones/m12-harness-fix/*.png`.

## Not touched (deferred as instructed)

Loading skeletons, dark mode, Accounts table density.
