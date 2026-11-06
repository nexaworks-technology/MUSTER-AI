# Admin guide: day 2 onward

For the workspace Admin. First day is in `docs/SETUP_GUIDE.md`. Product name: `src/config/product.ts`.
Everything here was checked against the code. Where a point could not be checked it says "Not verified".

## 1. Settings tabs and who sees them

Source: `src/app/(app)/settings/access.ts` and `src/lib/auth/permissions.ts`. A member sees only the
tabs they may use. A page the member may not use does not exist for them (it returns "not found").

| Tab | Path | Admin | CS Leader | CSM | Viewer |
|---|---|---|---|---|---|
| Users | `/settings/users` | Yes | No | No | No |
| Workspace | `/settings/workspace` | Yes | No | No | No |
| Import | `/settings/import` | Yes | Yes | No | No |
| Data quality | `/settings/data-quality` | Yes | Yes | No | No |
| Data (export, delete) | `/settings/data` | Yes | No | No | No |
| Integrations | `/settings/integrations` | Yes | No | No | No |
| Data health | `/settings/data-health` | Yes | Yes | No | No |
| Signals | `/settings/signals` | Yes | Yes | No | No |
| Health model | `/settings/health-model` | Yes | Yes | No | No |
| Surveys | `/settings/surveys` | Yes | Yes | No | No |
| Onboarding templates | `/settings/onboarding-templates` | Yes | Yes | No | No |
| AI team | `/settings/ai-team` | Yes | Yes | No | No |
| Audit | `/settings/audit` | Yes | Yes | No | No |
| System (Jobs) | `/settings/system/jobs` | Yes | No | No | No |
| Setup | `/setup` | Yes | No | No | No |

Only an Admin can activate a health model, turn on auto-send for a play, connect integrations, export
audit data and export or delete the workspace. A CS Leader can propose a health model and publish plays.

## 2. Members, roles, book scope, revenue visibility

Settings > Users. You can invite, change a role, change "Accounts they see", switch "Revenue access",
and revoke an invitation.

- **Roles:** Admin, CS Leader, CSM, Viewer. What each can do is in the table in `docs/SETUP_GUIDE.md`
  (from `src/lib/auth/permissions.ts`; tested in `src/lib/auth/__tests__/rbac-matrix.test.ts`).
- **Invitations** are emailed and expire after 7 days.
- **Book scope** (per person): Own accounts, Team, or All accounts. It narrows what a CSM sees and can
  act on. "Team" means the person's own accounts plus unowned accounts (`src/modules/accounts/service.ts`).
  Admin and CS Leader permissions grant all accounts. Viewer is read-only on all.
- **Revenue visibility:** a per-person switch ("Revenue access"), `canViewRevenue`. It controls ARR,
  contract values, forecasts and money in the ledger. It follows the switch for every role, including
  Admin (`revenue:view` in `src/lib/auth/permissions.ts`; test `revenue:view follows the per-membership flag for every role, never the role`).
  The database default is off (`prisma/schema.prisma`). Check your own Admin account has it if you need to see money.
  Without it, money fields show as restricted.
- **Today** lists each member's own accounts. Put `owner_email` on accounts, or unowned accounts
  appear on nobody's Today (a person with Team scope also sees the unowned pool). QUESTIONS Q-88.

## 3. Integrations and write-back

Settings > Integrations.

- Connected data sources read only. The card says "Connected · read-only". Slack is the exception: it
  posts notices to your team, never to your customers, so it is not labelled read-only.
- **Write-back** is a separate section per integration, shown only for integrations that can write:
  "Write-back to <provider>: off". It is off by default. To allow it, tick "Allow write-back", tick each
  field you allow, and save "Save write-back". Even then each change is written only after a person
  approves it. Changing the switch is audited, with before and after values.
  (`src/app/(app)/settings/integrations/page.tsx`; `src/modules/integrations/__tests__/writeback.test.ts`.)
- A live write also needs the deployment setting `WRITE_BACK_LIVE`, which is set by whoever runs the
  deployment, not in the app (`src/modules/integrations/__tests__/writeback-live.int.test.ts`).
- Credentials are stored encrypted and are never exported.

## 4. Usage API key (shown once)

On the Integrations page, the "Product usage" card (Usage API).

- Choose "Generate key". The key is shown **once**. Copy it then. We keep only a fingerprint and the last
  4 characters.
- Choose "Rotate key" to make a new one. Rotating stops the current key at once.
- Send events to the endpoint shown on the page (`/track`, `/identify`, `/batch`) with
  `Authorization: Bearer <key>`. Each event needs a `userId` and a `groupId` that matches an account
  (by account id, CRM id or domain).
- Segment: save a shared secret on the page and add a Webhooks destination in Segment.
- **No raw event history is kept.** Events are folded into daily totals per account, person and feature and then discarded
  (Q-33). Keep your own copy in your analytics tool if you need event-level history.
- Events older than 35 days are rejected (`src/modules/integrations/usage-api/receive.ts`).
- The limit is 600 requests per minute per key (see section 11).

## 5. AI team

Settings > AI team (Admin and CS Leader can view; only an Admin has the on/off switch).

- Each registered agent is listed with its version, whether it is on, its model tier and the reason,
  its prompt version, whether it is internal only, run counts, and recent runs. Each run opens its full
  record (`/agent-runs/<id>`): inputs by id, prompt version, model, output, citations.
- An Admin can switch an agent off or on. This is audited (`agent.enabled`, `agent.disabled`).
- If no AI key is configured, the page says "AI is not configured (no API key)". Agents do not run and
  nothing is shown in their place.
- Customer-facing drafts always go to Approvals. A play can send on its own only if an Admin enables auto-send for it
  and all the guards pass. Sensitive topics never send on their own.
- Note: the page's own sentence says auto-send is off "until plays arrive (M8)". Plays have shipped.
  The sentence is out of date; ignore it.

## 6. Audit log and export

Settings > Audit.

- Every action by a person or by AI, newest first. Nothing can be edited or deleted (a database trigger
  refuses). The only removal is the purge of a deleted workspace (see section 8).
- Filter by who (anyone, people, AI agents, system) and by person or agent, target type, and target or run id.
- **Export** (Admin only): "Export CSV" or "Export JSON" of the filtered trail, up to 10,000 rows
  (`EXPORT_LIMIT`, `src/modules/audit/service.ts`). The export is itself recorded as `audit.exported`.
- CS Leaders can view the log but not export it.

## 7. Data controls: export

Settings > Data (Admin only).

- **Export all data**: one ZIP in the background. It holds a JSON file per kind of record, a `files/` folder
  with the documents you uploaded, and `manifest.json` (counts, and a list of what was left out). The
  download link works for 7 days. Anyone with the link can download until it expires, so treat it as confidential.
- Money is exported in full, whoever can see it in the app. Contract terms and pricing notes are exported readable.
- **Never exported:** integration credentials, Usage API keys, invitation and portal link tokens,
  passwords, sign-in sessions, survey link tokens. Reconnect integrations after any restore.
- Each export request is audited. Only one export runs at a time.

## 8. Data controls: delete the workspace

Settings > Data > "Delete this workspace" (Admin only).

1. Type the workspace name exactly to confirm, then choose "Delete this workspace".
2. A 7-day grace period starts (`DELETION_GRACE_DAYS`). The page shows when the purge will happen.
3. To change your mind, choose "Cancel deletion" during those 7 days. Both actions are audited.
4. After the grace period, an hourly job deletes the stored files and then every record of the workspace.
   A minimal record that it existed and was deleted (name tag, dates, row counts) is kept.

The page states: deleted within 30 days of your request; copies in backups expire with the 35-day
backup retention (Q-10). Export first if you want a copy.
Not verified: the backup retention of your real deployment. That is an operations setting.
(Sources: `src/modules/settings/data-controls/purge.ts`, `src/app/(app)/settings/data/`.)

## 9. System > Jobs

Settings > System (`/settings/system/jobs`, Admin only). D-184.

- Shows, for each background queue, counts by state and the schedules, plus recent failed jobs.
- You see only jobs of **your own workspace**. System-wide sweeps appear as name, state and times only.
  Job contents are never shown. Counts cover only the latest 200 jobs in each state, so a number can show a "+".
- A failed job of your own workspace has a retry button. A retry is audited (`job.retried`).
  You cannot retry another workspace's job or a system-wide one.
- "Data health" (`/settings/data-health`) separately lists work that failed after all its tries, in plain words.

## 10. Health check and pilot metrics

**For operators: `GET /api/health`** (no sign-in needed). It returns 200 while the database and Redis answer, and
503 when either does not. The body gives `status`, `db`, `redis` and `worker`. A stale background worker is shown in the
body but does not fail the check (the worker writes a heartbeat; staleness is more than 90 seconds, D-184).
It is limited to 120 requests per minute per IP.

**Pilot metrics: `/reports/pilot-metrics`** (Admin and CS Leader only). Shows how each CSM used the product, for the last
4, 8 or 12 weeks (weeks run Monday to Sunday in the workspace time zone). Every figure links to the recorded events behind it.

| Word | Meaning (from the page) |
|---|---|
| Opens | Times a person opened Today or Approvals, counted at most once every 30 minutes. |
| Flag acceptance | Flags a person acknowledged or approved a draft for, over those plus flags they marked false alarm. One verdict per flag. "No data" when there are none, never 0. |
| Prep time (median, p90) | Minutes from a QBR or brief being generated to it being shared. A QBR counts as shared when it is locked for the customer portal. Credited to the person who generated it, in the week it was shared. |

Briefs have no share step in the product yet, so brief prep time shows "No data" (Q-87).
The events come from the `ProductEvent` table (ids and small values only; D-183).

## 11. Rate limits you may hit

When you hit a limit on a form you see: "Too many attempts. Wait a few minutes and try again."
(`src/lib/http/action-guard.ts`). Routes answer HTTP 429 with a `retry-after` header.
Numbers are in `LIMITS` in `src/lib/http/guard.ts`.

| Where | Limit | Window |
|---|---|---|
| Sign in, per IP address | 10 | 10 minutes |
| Sign in, per email address | 5 | 10 minutes |
| Invitations, per IP | 10 | 10 minutes |
| Integration webhooks, per integration | 600 | 1 minute |
| Customer portal pages, per IP | 60 | 1 minute |
| Survey links, per IP | 20 | 10 minutes |
| Ask AI, per member | 30 | 10 minutes |
| File uploads, per member | 30 | 10 minutes |
| `/api/health`, per IP | 120 | 1 minute |
| Usage API, per key | 600 | 1 minute (`USAGE_RATE_LIMIT`) |
| Repeated failed authentication on guarded endpoints | 20 failures from one IP blocks it | 10 minutes |

Files can be up to 25 MB.

## 12. What an Admin cannot do

- **See or change another workspace.** Every query is scoped by workspace, and the database enforces it
  (row-level security). The Jobs page hides other workspaces' jobs. Tests: `src/lib/db/__tests__/tenant-isolation.int.test.ts`,
  `tenant-enumeration.int.test.ts`.
- **Edit or delete audit records.** Not possible while the workspace is live.
- **Send a customer email without approval.** Not possible by any role. Auto-send needs the play switch plus the guards, and
  sensitive topics always wait for a person.
- **Edit health history.** Scores and their reasons are immutable once written.
- **See an integration's stored credentials.** They are encrypted and not shown.
- **Recover a deleted workspace after the purge.** Cancel is possible only during the 7-day grace period.
- **Make the AI produce a health, risk, forecast or money number.** Those come from code (D-75).
