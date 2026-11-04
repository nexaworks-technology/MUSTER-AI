import type { Metadata } from "next";
import { formatDate } from "@/lib/format";
import { CONTACT_STATUS_LABELS, ROLE_LABELS } from "@/modules/contacts/schemas";
import { can } from "@/lib/auth/permissions";
import { draftIntroAction } from "@/modules/contacts/actions/champion-guard";
import { listPeople, loadChampionGuard } from "@/modules/contacts/service";
import { loadAccount } from "../data";
import { MakeChampion } from "./make-champion";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx, account } = await loadAccount(id);
  const tz = ctx.workspace.timezone;
  const [people, guard] = await Promise.all([
    listPeople(ctx, account.id),
    loadChampionGuard(ctx, account.id),
  ]);
  const intro = Array.isArray(sp.intro) ? sp.intro[0] : sp.intro;
  const introNote = {
    drafted: "Introduction drafted. It is waiting in Approvals; nothing has been sent.",
    not_configured: "AI is not switched on for this workspace, so no draft was made.",
    failed: "The draft could not be made. Nothing was changed.",
    forbidden: "You can't draft introductions.",
  }[intro ?? ""];
  const canDraft = Boolean(can(ctx, "approvals:decide"));
  if (people.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No contacts recorded for this account yet.</p>
    );
  }
  return (
    <div className="space-y-4">
      {introNote ? (
        <p role="status" className="text-sm" data-testid="intro-note">
          {introNote}
        </p>
      ) : null}
      {guard ? (
        <section
          aria-labelledby="champion-guard"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950"
          data-testid="champion-guard"
        >
          <h2 id="champion-guard" className="font-medium">
            Champion Guard: {guard.champion.name} needs a back-up
          </h2>
          <p>{guard.reason}</p>
          {guard.candidates.length === 0 ? (
            <p className="text-muted-foreground mt-2">
              No one else on file has an email we can use. Add a contact to get a suggestion.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground mt-2">
                Next-best people to reach, in order, and why (from the records):
              </p>
              <ol className="mt-1 list-decimal space-y-2 pl-5">
                {guard.candidates.slice(0, 3).map((c) => (
                  <li key={c.contactId} data-testid="guard-candidate">
                    <span className="font-medium">{c.name}</span>
                    {c.title ? <span className="text-muted-foreground"> · {c.title}</span> : null}
                    <ul className="text-muted-foreground list-disc pl-5">
                      {c.reasons.map((r, n) => (
                        <li key={n}>{r.text}</li>
                      ))}
                    </ul>
                    {canDraft ? (
                      <form action={draftIntroAction} className="mt-1">
                        <input type="hidden" name="accountId" value={account.id} />
                        <input type="hidden" name="candidateContactId" value={c.contactId} />
                        <button
                          type="submit"
                          className="bg-background rounded-md border px-2 py-1 text-xs"
                          data-testid="draft-intro"
                        >
                          Draft an introduction
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      ) : null}
      <ul className="divide-border border-border divide-y rounded-md border">
        {people.map((p) => (
          <li
            key={p.id}
            id={`contact-${p.id}`}
            className="target:bg-muted flex scroll-mt-4 flex-wrap items-start justify-between gap-3 p-3 text-sm"
            data-testid={`person-${p.name}`}
          >
            <div className="space-y-0.5">
              <div>
                <span className="font-medium">{p.name}</span>
                {p.title ? <span className="text-muted-foreground"> · {p.title}</span> : null}
              </div>
              <div className="text-muted-foreground">{p.email ?? "No email on file"}</div>
              <div>
                {p.currentRoles.length > 0 ? (
                  p.currentRoles.map((r) => ROLE_LABELS[r]).join(", ")
                ) : (
                  <span className="text-muted-foreground">No current role</span>
                )}
                {p.pastRoles.map((r) => (
                  <span key={r.id} className="text-muted-foreground ml-2 text-xs">
                    (former {ROLE_LABELS[r.role].toLowerCase()} until {formatDate(r.validTo, tz)})
                  </span>
                ))}
              </div>
              <div className="text-muted-foreground text-xs">
                Status:{" "}
                <span
                  data-testid="contact-status"
                  className={p.status === "ACTIVE" ? undefined : "text-[var(--risk-at-risk)]"}
                >
                  {CONTACT_STATUS_LABELS[p.status]}
                </span>
                {" · "}Last contact:{" "}
                {p.lastContactAt ? formatDate(p.lastContactAt, tz) : "none recorded"}
              </div>
            </div>
            {account.canEdit && !p.currentRoles.includes("CHAMPION") ? (
              <MakeChampion accountId={account.id} contactId={p.id} name={p.name} />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
