# Docker verification — M1 acceptance #16 closed

**Date:** 2026-11-09 · **Result:** PASS, after seven boot fixes (all in `Dockerfile` / `docker-compose.yml`; no test was edited).

## Environment

- Apple Silicon Mac (arm64), macOS 26. Docker Desktop was **not** installed, so the run used **Colima** (Homebrew) with the Docker CLI 29.9.3 and **Compose 5.7.0 as the standalone `docker-compose` binary** (the `docker compose` plugin was not registered; nothing else differs).
- Colima VM: 4 CPU, 8 GB RAM, 60 GB disk, `docker` runtime. Classic builder (no buildx plugin installed).
- Compose was run with two files kept **outside the repo** (scratchpad): an env file derived from `.env` with the container hostnames (`postgres`, `redis`, `minio`) and `APP_URL`, and an override that remaps host ports, because this machine already ran native Postgres/Redis/MinIO on 5432/6379/9000 and a dev server on 3000. Host ports used: web 3300, Postgres 55432, Redis 56379, MinIO 59000/59001, clamd 53310.
- The Resend values in that env file were **placeholders** (`re_placeholder_…`, `verify@example.test`). No email path was exercised. Live Resend remains DEFERRED (M12 sweep #21).
- AI was off (`ANTHROPIC_API_KEY` empty, `AI_PROVIDER=anthropic`); nothing in this run calls a model.

## What broke and what changed

| # | Symptom (first real failure) | Cause | Change |
|---|---|---|---|
| 1 | `docker compose build` → `ERR_PNPM_IGNORED_BUILDS` (Prisma, esbuild, …) during `pnpm install --frozen-lockfile` | The deps stage copied `package.json` and the lockfile but not `pnpm-workspace.yaml`, which holds the install-script allowlist (`allowBuilds`) | `Dockerfile`: copy `pnpm-workspace.yaml` in the deps stage and into the runner |
| 2 | `pnpm build` → `JavaScript heap out of memory` in "Running TypeScript" | Node's default ~2 GB heap is too small for this codebase's typecheck; web and worker also build the same image in parallel | `Dockerfile` builder stage: `NODE_OPTIONS=--max-old-space-size=4096` |
| 3 | `docker compose up` → `no matching manifest for linux/arm64/v8` for ClamAV | `clamav/clamav:stable_base` is published for amd64 only | `docker-compose.yml`: `platform: linux/amd64` on `clamav` (no-op on x86; emulated on Apple Silicon) |
| 4 | `pnpm deploy:release` → `bash: not found` | Alpine ships busybox `sh`; `scripts/deploy-release.sh` is bash | `Dockerfile` runner: `apk add --no-cache bash` |
| 5 | Healthcheck and worker → `Cannot find package '@/lib'`; worker crash-looped | `tsconfig.json` (the `@/` alias used by `tsx` at runtime) was not in the runner image | `Dockerfile` runner: copy `tsconfig.json` |
| 6 | Worker → `FIELD_ENCRYPTION_KEY: expected string`, then `SLACK_DELIVERY` / `EMAIL_TRANSPORT … development and test only` | Compose passed neither the required key nor the production-valid email/Slack transport settings. The production guards in `src/lib/config/env.ts` are correct and were **not** loosened | `docker-compose.yml`: pass `FIELD_ENCRYPTION_KEY` (required), `EMAIL_TRANSPORT` (default `resend`), `EMAIL_FROM` and `RESEND_API_KEY` (required), `SLACK_DELIVERY` (default `live`) to web and worker |
| 7 | Seed → `prompt "watcher-extraction" not found` | The runner image had no `prompts/` directory, which `src/lib/ai/prompts.ts` loads from `process.cwd()` at runtime. AI agents would have failed in production | `Dockerfile` runner: copy `prompts/` |

Also stated plainly: the demo seed refuses to run in production, so it was run once with `-e ALLOW_DEMO_SEED=true` on the throwaway volume (the seed's own documented switch).

## Evidence

### 1. `docker compose build`

Exit 0. Web and worker images built (sequentially, `COMPOSE_PARALLEL_LIMIT=1`; with the heap fix a parallel build in the 8 GB VM is tight). Final image tags: `nexaworks-csm-web`, `nexaworks-csm-worker`.

### 2. Fresh volumes → `pnpm deploy:release` → healthcheck

`docker compose down -v`, then `up -d`. `pnpm deploy:release` inside the web container:

- `41 migrations found … All migrations have been successfully applied.`
- `[apply-grants] Successfully applied grants to app_user.`
- Step 3 (its built-in healthcheck) **FAILED on ClamAV** on this first cold run: clamd was still loading signatures about 50 s after the volume was created (emulated amd64). See "Operational notes".

Healthcheck re-run once clamd was ready (`pnpm exec tsx scripts/healthcheck.ts`, with `APP_URL` pointed at the container port):

```
[✓ OK] Database   Connected and responding to queries
[✓ OK] Redis      Responding at redis://redis:6379
[✓ OK] ClamAV     clamd active and responding PONG (clamav:3310)
[✓ OK] Worker     Worker active (last heartbeat 18s ago)
[✓ OK] Web Server GET http://localhost:3000/api/health status 200 (ok)
Overall Status: PASSED
```

### 3. Browser smoke test (production build, `http://localhost:3300`)

- **Sign in** as the seeded demo Admin (`admin@larkspur.test`, seed password from `prisma/seed/users.ts`) → redirected to `/today`.
- **Production CSP confirmed** on a response header: `script-src 'self' 'nonce-…' 'strict-dynamic'`, `style-src 'self' 'nonce-…'`, `object-src 'none'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`; plus `Strict-Transport-Security: max-age=63072000; includeSubDomains` and `X-Frame-Options: DENY`.
- **Today** rendered ("Good afternoon, Priya"; empty-state cards, because the nightly health/signals run was not executed on this fresh seed). No console errors.
- **Accounts** rendered "Showing 1–50 of 72" with health values and the filter bar. Console: two `preload … not used` warnings only; no CSP violations.
- **Public survey** (`/s/<signed token>`, token minted inside the container with the app's own `createSurveyToken`): the form rendered, score 9 was selected and submitted, page showed "Thank you — your answer was recorded." No console errors. That response became a known row for the backup drill.

### 4. Backup drill

| Step | Result |
|---|---|
| Baseline counts | Workspace 1, User 5, Account 72, Contact 164, SurveyResponse 2, AgentRun 17, `_prisma_migrations` 41 |
| `pg_dump -Fc nexaworks_dev` (inside the container) | 2,903,548 bytes |
| Wipe | `docker compose down`, `docker volume rm nexaworks-csm_postgres-data`; new volume came up with 0 public tables |
| Restore | `pg_restore -U postgres -d nexaworks_dev --exit-on-error` → exit 0, no output |
| Counts after | Identical for every table except AgentRun (17 → 70). All 17 original rows are present (`createdAt` before the wipe); the other 53 were created at 14:46:33, when the worker started after the restore and ran its on-boot agent jobs. This is new activity, not a restore difference |
| `prisma migrate status` | `Database schema is up to date!` |
| Healthcheck | All five probes OK, `Overall Status: PASSED` |
| App | The browser session from before the wipe still worked (sessions are in the restored DB); `/accounts` showed "Showing 1–50 of 72"; the 5 seeded users are present |

### 5. `docker compose down`

Done; no `nexaworks-csm` containers or network remain. Named volumes were kept (down without `-v`). Three exited intermediate containers from the failed build attempts remain in the Colima VM and can be removed with `docker container prune`.

## Operational notes (not fixed; decide before production)

1. **`pnpm healthcheck` does not work inside the image.** The package script is `tsx --env-file=.env …` and the image has no `.env` (`.dockerignore` excludes it, correctly). Inside the container use `pnpm exec tsx scripts/healthcheck.ts`, as `deploy-release.sh` already does. Setting `APP_URL` to the public URL makes the Web probe hit the public address, so it fails from inside the container if the container cannot reach itself that way.
2. **The release script's healthcheck can fail on a cold ClamAV.** The compose healthcheck for `clamav` ends in `|| exit 0` (always healthy), and web/worker only wait for `service_started`. On a brand-new volume clamd needed about 50–60 s. Re-running the healthcheck passes. Consider a real clamd readiness check before `deploy:release`.
3. **The worker crash-loops until migrations are applied** on a fresh database (`The table public.Workspace does not exist`) and recovers through `restart: unless-stopped`. It reached 8 restarts before the release ran in this drill.
4. **The web image downloads pnpm at start** (`Corepack is about to download … pnpm-12.3.4`) because the non-root user has no corepack cache. It needs outbound network on every container start; baking it in at build time would remove that.
5. **Demo seed in a production container** needs `ALLOW_DEMO_SEED=true`; it is deliberately refused otherwise.
6. **`.env.example`** already lists `EMAIL_FROM`, `RESEND_API_KEY` and `FIELD_ENCRYPTION_KEY`; compose now requires all three, and `docker compose` refuses to start with a clear message if one is empty.
7. ClamAV runs under amd64 emulation on Apple Silicon; fine for verification, slow to start.
