import type { Metadata } from "next";
import type { Route } from "next";
import Link from "next/link";
import { AiText } from "@/components/app/ai-text";
import { formatCalendarDate } from "@/lib/format";
import { adoptionFinding } from "@/modules/agents/service";
import { getAdoption, type Adoption } from "@/modules/usage/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Adoption" };

type Source = NonNullable<Adoption["seats"]>["sources"][number];

const day = (d: string) => formatCalendarDate(new Date(`${d}T00:00:00Z`));

/** Every figure links to the rows behind it (Rule 1): a usage range opens the Usage tab on it. */
function SourceLinks({ accountId, sources }: { accountId: string; sources: Source[] }) {
  const ranges = sources.filter((s) => s.from && s.to && s.sourceType !== "FeatureCatalog");
  const days = sources.filter((s) => s.sourceId && s.sourceType === "UsageDaily");
  if (!ranges.length && !days.length) return null;
  return (
    <p className="text-muted-foreground text-xs">
      From{" "}
      {[
        ...ranges.map((s, i) => (
          <Link
            key={`r${i}`}
            className="underline"
            href={`/accounts/${accountId}/usage?from=${s.from}&to=${s.to}` as Route}
          >
            {s.sourceType === "FeatureUsageDaily"
              ? "feature use"
              : s.sourceType === "UserUsageDaily"
                ? "per-person use"
                : "daily use"}{" "}
            {day(s.from!)}–{day(s.to!)}
          </Link>
        )),
        ...days.map((s, i) => (
          <Link
            key={`d${i}`}
            className="underline"
            href={`/accounts/${accountId}/usage?from=${s.date}&to=${s.date}` as Route}
          >
            daily use on {day(s.date!)}
          </Link>
        )),
      ].flatMap((el, i) => (i ? [", ", el] : [el]))}
    </p>
  );
}

/**
 * Account 360 › Adoption (spec §6G4, M6 D6: beside Usage, not instead of it). The same rows as the
 * Usage tab, said the way a CSM would say them, each figure linked to its rows.
 */
export default async function AdoptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const [a, coach] = await Promise.all([
    getAdoption(ctx, account.id),
    adoptionFinding(ctx, account.id),
  ]);
  const nothing = !a.seats && !a.features && !a.powerUsers && !a.trend;
  return (
    <div className="max-w-3xl space-y-6">
      <h2 className="text-base font-semibold">Adoption</h2>
      {nothing ? (
        <p className="text-sm" data-testid="no-adoption">
          Nothing to show yet: no product usage has been recorded for this account.
        </p>
      ) : null}

      {coach.run ? (
        <section aria-labelledby="adopt-coach" className="space-y-1" data-testid="adoption-coach">
          <h3 id="adopt-coach" className="font-medium">
            What the Adoption Coach found
          </h3>
          <AiText
            run={coach.run}
            items={coach.items}
            emptyText={`Nothing here needs action. ${coach.reasoningSummary ?? ""}`.trim()}
          />
          {coach.missing.length ? (
            <p className="text-muted-foreground text-xs">
              Not on file: {coach.missing.join("; ")}.
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            Its nudge, if any, waits in Approvals. Nothing is sent without a person.
          </p>
        </section>
      ) : null}

      {a.features ? (
        <section aria-labelledby="adopt-features" className="space-y-1">
          <h3 id="adopt-features" className="font-medium">
            Features
          </h3>
          <p data-testid="adoption-features">{a.features.text}.</p>
          {a.features.neverUsed.length ? (
            <p className="text-sm">
              Never used: {a.features.neverUsed.join(", ")}
              {a.features.keyNeverUsed.length
                ? ` (key: ${a.features.keyNeverUsed.join(", ")})`
                : ""}
              .
            </p>
          ) : null}
          {a.features.used.length ? (
            <p className="text-sm">In use: {a.features.used.join(", ")}.</p>
          ) : null}
          <SourceLinks accountId={account.id} sources={a.features.sources} />
        </section>
      ) : null}

      {a.seats || a.credits ? (
        <section aria-labelledby="adopt-seats" className="space-y-1">
          <h3 id="adopt-seats" className="font-medium">
            Seats{a.credits ? " and credits" : ""}
          </h3>
          {a.seats ? (
            <>
              <p data-testid="adoption-seats">
                {a.seats.text}.
                {a.seats.status === "UNDER" ? " Most of what was bought is not being used." : ""}
              </p>
              <SourceLinks accountId={account.id} sources={a.seats.sources} />
            </>
          ) : null}
          {a.credits ? (
            <>
              <p>{a.credits.text}.</p>
              <SourceLinks accountId={account.id} sources={a.credits.sources} />
            </>
          ) : null}
        </section>
      ) : null}

      {a.trend ? (
        <section aria-labelledby="adopt-trend" className="space-y-1">
          <h3 id="adopt-trend" className="font-medium">
            Use over time
          </h3>
          <p>{a.trend.text}.</p>
          {a.trend.cohortText ? <p data-testid="adoption-cohort">{a.trend.cohortText}.</p> : null}
          <SourceLinks accountId={account.id} sources={a.trend.sources} />
        </section>
      ) : null}

      {a.powerUsers ? (
        <section aria-labelledby="adopt-power" className="space-y-1">
          <h3 id="adopt-power" className="font-medium">
            Power users
          </h3>
          <p>{a.powerUsers.text}.</p>
          <ul className="list-disc pl-5 text-sm">
            {a.powerUsers.users.map((u) => (
              <li key={u.name}>
                {u.name}: {u.stillActive ? "still active" : "not active in the last 28 days"}
              </li>
            ))}
          </ul>
          <SourceLinks accountId={account.id} sources={a.powerUsers.sources} />
        </section>
      ) : null}

      {a.missing.length ? (
        <ul className="text-muted-foreground list-disc pl-5 text-sm">
          {a.missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
