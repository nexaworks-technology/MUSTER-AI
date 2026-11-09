# HEAD certification — 2026-11-09

**Result: PASS.** `pnpm gate`, then the full `pnpm test:e2e` (both AI configs), run at a clean HEAD with no working-tree changes and no edits made during the run.

- **Commit certified:** `41d8875ff84817ae04b0db1fb38a5e9002008c6c` (`chore(design): commit Design 2.0 screenshot capture scripts as evidence tooling`). Pre-run `git status --short` printed nothing.
- **Host:** macOS (arm64), native Postgres and Redis (no Docker), production builds served on :3100 (recorded AI) and :3101 (no AI) by `scripts/e2e.ts`. No live model is reachable.

## `pnpm gate` — exit 0

| Step | Result |
|---|---|
| typecheck | pass |
| lint (eslint `--max-warnings=0` + secret check) | pass; `secret-check: 1630 files scanned, no secrets found` |
| test (Vitest) | **333 files passed, 1 skipped (334); 2,938 tests passed, 5 skipped (2,943); 0 failed** |
| build | `✓ Compiled successfully` |

The `status: "FAILED"` lines in the log are agent-run records written by tests that exercise failure paths (for example `MODEL_DECLINED`, `PROVIDER_HTTP_529`); they are expected output, not test failures.

## `pnpm test:e2e` — exit 0

| Run | Config | Tests | Passed | Failed | Skipped | Time |
|---|---|---|---|---|---|---|
| main (recorded AI) | `playwright.config.ts` | 176 | **101** | **0** | 75 | 3.4 min |
| AI-off | `playwright.aioff.config.ts` | 17 | **17** | **0** | 0 | 50.9 s |
| **Total** | | 193 | **118** | **0** | 75 | |

**Skips explained:** all 75 skipped tests are in the `mobile` project (desktop: 0 skipped). They are specs that call `test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only")`. Main run split: desktop 88 passed, mobile 13 passed, mobile 75 skipped.

## Notes

- One `[auth][error] CredentialsSignin` line appears in the web-server output during the run. It is the server logging a rejected sign-in during a test (the run passed); it was not investigated further.
- Running the e2e suite regenerated one tracked evidence image, `docs/milestones/m11-evidence/ledger-leo.png`. It is left uncommitted and unreverted (see the working-tree note in the session report); it is test output, not product code.
- Not covered by this run: live-model evals (`pnpm eval`, DEFERRED without `ANTHROPIC_API_KEY`), live Resend, live connector sandboxes, and a real Docker Desktop/amd64 host. Container boot was verified separately in `docs/DOCKER-VERIFICATION.md`.
