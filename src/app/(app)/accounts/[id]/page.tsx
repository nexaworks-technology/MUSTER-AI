import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatArr, formatCalendarDate, formatDate, RESTRICTED } from "@/lib/format";
import { STAGE_LABELS, TIER_LABELS } from "@/modules/accounts/schemas";
import { CONTACT_STATUS_LABELS, ROLE_LABELS } from "@/modules/contacts/schemas";
import { listPeople } from "@/modules/contacts/service";
import { getMissingDataQuestion, listOwners } from "@/modules/accounts/service";
import { MissingDataCard } from "@/components/app/missing-data-card";
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
    <div className="grid gap-4 lg:grid-cols-2">
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
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Account</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Key people</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {keyPeople.length === 0 ? (
            <p className="text-muted-foreground text-sm">No champion or decision maker recorded.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {keyPeople.map((p) => (
                <li key={p.id}>
                  <span className="font-medium">{p.name}</span>{" "}
                  <span className="text-muted-foreground">
                    {p.currentRoles.map((r) => ROLE_LABELS[r]).join(", ")}
                    {p.title ? ` · ${p.title}` : ""}
                  </span>
                  {p.status !== "ACTIVE" ? (
                    <span className="ml-2 rounded border border-[var(--risk-at-risk)] px-1.5 py-0.5 text-xs text-[var(--risk-at-risk)]">
                      {CONTACT_STATUS_LABELS[p.status]}
                    </span>
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
