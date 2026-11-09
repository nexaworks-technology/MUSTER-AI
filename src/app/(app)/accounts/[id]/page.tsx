import type { Metadata } from "next";
import { DataListAvatar } from "@/components/app/data-list";
import { EmptyState } from "@/components/app/empty-state";
import { MissingDataCard } from "@/components/app/missing-data-card";
import { StatusPill } from "@/components/app/status-pill";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatArr, formatCalendarDate, formatDate, RESTRICTED } from "@/lib/format";
import { STAGE_LABELS, TIER_LABELS } from "@/modules/accounts/schemas";
import { CONTACT_STATUS_LABELS, ROLE_LABELS } from "@/modules/contacts/schemas";
import { listPeople } from "@/modules/contacts/service";
import { getMissingDataQuestion, listOwners } from "@/modules/accounts/service";
import { loadAccount } from "./data";

export const metadata: Metadata = { title: "Account" };

export default async function AccountOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const tz = ctx.workspace.timezone;
  const [people, missing, owners] = await Promise.all([
    listPeople(ctx, account.id),
    getMissingDataQuestion(ctx, account.id),
    listOwners(ctx),
  ]);
  const keyPeople = people.filter((p) =>
    p.currentRoles.some((r) => r === "CHAMPION" || r === "DECISION_MAKER"),
  );

  const facts: Array<[string, React.ReactNode]> = [
    [
      "Tier",
      `${TIER_LABELS[account.tier]} (${account.tierSource === "MANUAL" ? "set manually" : "set by ARR rule"})`,
    ],
    ["Stage", STAGE_LABELS[account.lifecycleStage]],
    ["Owner", account.ownerName ?? "No owner"],
    [
      "ARR",
      account.arrVisible
        ? account.arr
          ? formatArr(account.arr)
          : "No contract on file"
        : RESTRICTED,
    ],
    ["Plan", account.plan ?? "Not recorded"],
    ["Industry", account.industry ?? "Not recorded"],
    ["Company size", account.employeeBand ? `${account.employeeBand} employees` : "Not recorded"],
    ["Domain", account.domain ?? "Not recorded"],
    [
      "Last touch",
      account.lastTouchAt ? formatDate(account.lastTouchAt, tz) : "No contact recorded",
    ],
  ];
  if (account.onboardingStartedAt)
    facts.push(["Onboarding started", formatCalendarDate(account.onboardingStartedAt)]);
  if (account.churnedAt) facts.push(["Churned", formatCalendarDate(account.churnedAt)]);

  const missingOptions =
    missing?.field === "OWNER"
      ? owners.map((o) => ({ value: o.membershipId, label: o.name }))
      : missing?.field === "KEY_CONTACT"
        ? people.map((p) => ({ value: p.id, label: p.name }))
        : [];

  return (
    <div className="gap-section grid lg:grid-cols-2">
      {missing ? (
        <div className="lg:col-span-2">
          <MissingDataCard
            accountId={account.id}
            field={missing.field}
            question={missing.question}
            snoozeDays={missing.snoozeDays}
            options={missingOptions}
          />
        </div>
      ) : null}

      {/* Account Facts Card */}
      <Card className="rounded-xl border border-border/80 shadow-xs">
        <CardHeader className="border-b border-border/60 py-3.5 px-5">
          <CardTitle>
            <h2 className="text-base font-semibold text-foreground">Account</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5">
          <dl className="divide-border/40 divide-y text-xs sm:text-sm">
            {facts.map(([k, v]) => (
              <div key={k} className="flex gap-4 py-2.5 first:pt-0 last:pb-0 items-baseline">
                <dt className="text-muted-foreground w-36 shrink-0 font-medium">{k}</dt>
                <dd className="min-w-0 text-foreground font-normal">{v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {/* Key People Card */}
      <Card className="rounded-xl border border-border/80 shadow-xs">
        <CardHeader className="border-b border-border/60 py-3.5 px-5">
          <CardTitle>
            <h2 className="text-base font-semibold text-foreground">Key people</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5">
          {keyPeople.length === 0 ? (
            <EmptyState>No champion or decision maker recorded.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/40">
              {keyPeople.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <DataListAvatar name={p.name} size="sm" />
                    <div className="min-w-0">
                      <div className="font-medium text-foreground text-xs sm:text-sm truncate">
                        {p.name}
                      </div>
                      <div className="text-muted-foreground text-xs truncate">
                        {p.currentRoles.map((r) => ROLE_LABELS[r]).join(", ")}
                        {p.title ? ` · ${p.title}` : ""}
                      </div>
                    </div>
                  </div>
                  {p.status !== "ACTIVE" ? (
                    <StatusPill variant="danger" size="sm">
                      {CONTACT_STATUS_LABELS[p.status]}
                    </StatusPill>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
