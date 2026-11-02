import type { Metadata } from "next";
import { formatDate } from "@/lib/format";
import { CONTACT_STATUS_LABELS, ROLE_LABELS } from "@/modules/contacts/schemas";
import { listPeople } from "@/modules/contacts/service";
import { loadAccount } from "../data";
import { MakeChampion } from "./make-champion";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const tz = ctx.workspace.timezone;
  const people = await listPeople(ctx, account.id);
  if (people.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No contacts recorded for this account yet.</p>
    );
  }
  return (
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
  );
}
