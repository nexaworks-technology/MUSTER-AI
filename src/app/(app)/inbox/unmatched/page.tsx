import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { assignUnmatchedAction, dismissUnmatchedAction } from "@/modules/inbox/actions/inbox";
import { listAssignableAccounts, listUnmatched } from "@/modules/inbox/service";

export const metadata: Metadata = { title: "Unmatched mail" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Mail no one could place on exactly one account. It waits here until a person decides (never auto-assigned). */
export default async function UnmatchedPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  if (!can(ctx, "accounts:edit")) notFound();
  const sp = await searchParams;
  const [rows, accounts] = await Promise.all([listUnmatched(ctx), listAssignableAccounts(ctx)]);
  const tz = ctx.workspace.timezone;
  const error = first(sp.error);
  const done = first(sp.done);
  return (
    <div className="space-y-4">
      <div>
        <Link href={"/inbox" as Route} className="text-muted-foreground text-sm underline">
          ← Inbox
        </Link>
        <h1 className="text-2xl font-semibold">Unmatched mail</h1>
        <p className="text-muted-foreground text-sm">
          These emails matched no contact, or matched more than one account. Nothing is guessed:
          place each one, or dismiss it. Placing it moves the text into the account&apos;s
          conversations and removes it from here; both are recorded in the audit log.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
          {done === "assigned" ? "Placed on the account." : "Dismissed."}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="unmatched-empty">
          No unmatched mail.
        </p>
      ) : (
        <ul
          className="divide-border border-border divide-y rounded-md border"
          data-testid="unmatched-list"
        >
          {rows.map((r) => (
            <li key={r.id} className="space-y-2 p-3 text-sm" data-testid="unmatched-item">
              <p>
                <span className="font-medium">{r.subject ?? "(no subject)"}</span>{" "}
                <span className="text-muted-foreground">
                  from {r.fromAddress} · {formatDateTime(r.receivedAt, tz)}
                </span>
              </p>
              <p className="text-muted-foreground">{r.snippet}</p>
              <p className="text-xs">Why it is here: {r.reason}</p>
              <div className="flex flex-wrap items-end gap-3">
                <form action={assignUnmatchedAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="id" value={r.id} />
                  <label className="text-xs">
                    <span className="block">Place on account</span>
                    <select
                      name="accountId"
                      required
                      defaultValue=""
                      className="border-input bg-background mt-1 rounded-md border px-2 py-1 text-sm"
                    >
                      <option value="" disabled>
                        Choose…
                      </option>
                      {r.candidates.length > 0 ? (
                        <optgroup label="Candidates">
                          {r.candidates.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      <optgroup label="All accounts">
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                  <button
                    type="submit"
                    className="bg-primary text-primary-foreground rounded-md px-3 py-1 text-sm"
                  >
                    Place
                  </button>
                </form>
                <form action={dismissUnmatchedAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <button type="submit" className="rounded-md border px-3 py-1 text-sm">
                    Dismiss
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
