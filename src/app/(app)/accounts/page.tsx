import type { Metadata } from "next";
import Link from "next/link";
import { InlineField } from "@/components/app/inline-field";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatArr, formatCalendarDate, formatDate, RESTRICTED } from "@/lib/format";
import {
  accountListQuery,
  STAGE_LABELS,
  STAGES,
  TIER_LABELS,
  TIERS,
} from "@/modules/accounts/schemas";
import { listAccounts, listOwners } from "@/modules/accounts/service";
import { listSegments } from "@/modules/segments/service";
import { SaveSegment } from "@/components/app/save-segment";
import { can } from "@/lib/auth/permissions";
import { PulseControls } from "@/components/app/pulse-controls";
import { DisagreementMark, RISK_WORDS, RiskBadge } from "@/components/app/risk-badge";
import { healthForAccounts } from "@/modules/health/service";

const HEALTH_LEVELS = ["HEALTHY", "WATCH", "AT_RISK", "INSUFFICIENT_DATA"] as const;
const PULSE_WORDS = { FINE: "Actually fine", WORRIED: "Worried" } as const;

export const metadata: Metadata = { title: "Accounts" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(params: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? (v[0] ?? "") : (v ?? "")]),
  );
}

export default async function AccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const raw = single(await searchParams);
  const parsed = accountListQuery.safeParse(raw);
  const query = parsed.success ? parsed.data : accountListQuery.parse({});
  const [page, owners, segments] = await Promise.all([
    listAccounts(ctx, query),
    listOwners(ctx),
    listSegments(ctx),
  ]);
  const hasListFilters = Boolean(
    query.q || query.tier || query.stage || query.owner || query.health,
  );
  // Health and Pulse come from the health module in one batch for this page (M3 slice 8).
  const health = await healthForAccounts(
    ctx,
    page.rows.map((a) => a.id),
  );
  const tz = ctx.workspace.timezone;

  const pageHref = (cursor: string) => ({
    pathname: "/accounts" as const,
    query: { ...raw, cursor },
  });

  return (
    <div className="space-y-section">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
      </div>
      <form
        method="get"
        className="surface flex flex-wrap items-end gap-3 p-4"
        role="search"
        aria-label="Filter accounts"
      >
        <div className="space-y-1">
          <label htmlFor="q" className="text-muted-foreground block text-xs">
            Search
          </label>
          <Input
            id="q"
            name="q"
            defaultValue={query.q ?? ""}
            placeholder="Name or domain"
            className="w-56"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="tier" className="text-muted-foreground block text-xs">
            Tier
          </label>
          <NativeSelect id="tier" name="tier" defaultValue={query.tier ?? ""}>
            <option value="">All tiers</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {TIER_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="stage" className="text-muted-foreground block text-xs">
            Stage
          </label>
          <NativeSelect id="stage" name="stage" defaultValue={query.stage ?? ""}>
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="health" className="text-muted-foreground block text-xs">
            Health
          </label>
          <NativeSelect id="health" name="health" defaultValue={query.health ?? ""}>
            <option value="">Any health</option>
            {HEALTH_LEVELS.map((h) => (
              <option key={h} value={h}>
                {RISK_WORDS[h]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="owner" className="text-muted-foreground block text-xs">
            Owner
          </label>
          <NativeSelect id="owner" name="owner" defaultValue={query.owner ?? ""}>
            <option value="">Anyone</option>
            <option value="none">No owner</option>
            {owners.map((o) => (
              <option key={o.membershipId} value={o.membershipId}>
                {o.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="segment" className="text-muted-foreground block text-xs">
            Segment
          </label>
          <NativeSelect id="segment" name="segment" defaultValue={query.segment ?? ""}>
            <option value="">No segment</option>
            {segments
              .filter((sg) => sg.valid)
              .map((sg) => (
                <option key={sg.id} value={sg.id}>
                  {sg.name}
                </option>
              ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="sort" className="text-muted-foreground block text-xs">
            Sort by
          </label>
          <NativeSelect id="sort" name="sort" defaultValue={query.sort}>
            <option value="name">Name</option>
            {page.arrVisible ? <option value="arr">ARR</option> : null}
            <option value="renewal">Renewal date</option>
            <option value="lastTouch">Last touch</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="dir" className="text-muted-foreground block text-xs">
            Order
          </label>
          <NativeSelect id="dir" name="dir" defaultValue={query.dir}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Apply
        </Button>
        <Link href="/accounts" className="text-primary py-2 text-sm hover:underline">
          Clear
        </Link>
      </form>

      {page.segmentMissing ? (
        <p
          role="alert"
          className="bg-danger-soft text-danger-soft-foreground rounded-md px-3 py-2 text-sm"
        >
          That segment doesn&apos;t exist in this workspace, so it was ignored.
        </p>
      ) : null}
      {hasListFilters && can(ctx, "accounts:edit") ? (
        <SaveSegment
          filters={{ q: query.q, tier: query.tier, stage: query.stage, owner: query.owner }}
        />
      ) : null}
      {!parsed.success ? (
        <p
          role="alert"
          className="bg-danger-soft text-danger-soft-foreground rounded-md px-3 py-2 text-sm"
        >
          Some filters were not valid and were ignored.
        </p>
      ) : null}

      <p className="text-muted-foreground text-sm" aria-live="polite">
        {page.total === 0
          ? "No accounts match these filters."
          : `Showing ${page.offset + 1}–${page.offset + page.rows.length} of ${page.total}`}
      </p>

      {page.rows.length > 0 ? (
        <div
          className="surface overflow-x-auto"
          role="region"
          aria-label="Accounts table"
          tabIndex={0}
        >
          <table className="w-full min-w-224 text-sm">
            <caption className="sr-only">Accounts</caption>
            <thead>
              <tr>
                <th scope="col" className="px-2">
                  Name
                </th>
                <th scope="col" className="px-2">
                  Health
                </th>
                <th scope="col" className="px-2">
                  CSM Pulse
                </th>
                <th scope="col" className="px-2">
                  Tier
                </th>
                <th scope="col" className="px-2">
                  Stage
                </th>
                <th scope="col" className="px-2">
                  Owner
                </th>
                <th scope="col" className="px-2 text-right">
                  ARR
                </th>
                <th scope="col" className="px-2">
                  Renewal date
                </th>
                <th scope="col" className="px-2">
                  Last touch
                </th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((a) => (
                <tr key={a.id}>
                  <td className="px-2">
                    <Link href={`/accounts/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    {a.domain ? (
                      <div className="text-muted-foreground text-xs">{a.domain}</div>
                    ) : null}
                  </td>
                  <td className="px-2">
                    {(() => {
                      const h = health.get(a.id);
                      if (!h?.riskLevel)
                        return <span className="text-muted-foreground">Not scored yet</span>;
                      return (
                        <Link
                          href={`/accounts/${a.id}/health`}
                          className="inline-flex items-center gap-2 hover:underline"
                          aria-label={`Health ${h.overall ?? "not enough data"}, ${RISK_WORDS[h.riskLevel]}: why`}
                        >
                          <span className="tabular-nums">
                            {h.overall === null ? "—" : h.overall.toFixed(0)}
                          </span>
                          <RiskBadge level={h.riskLevel} />
                        </Link>
                      );
                    })()}
                  </td>
                  <td className="px-2">
                    {(() => {
                      const h = health.get(a.id);
                      return (
                        <div className="space-y-1">
                          {h?.pulse?.valid ? (
                            <span className="inline-flex flex-wrap items-center gap-1">
                              <span>{PULSE_WORDS[h.pulse.value]}</span>
                              {h.pulseDisagreement ? <DisagreementMark /> : null}
                            </span>
                          ) : null}
                          {a.canEdit ? (
                            <PulseControls accountId={a.id} accountName={a.name} compact />
                          ) : null}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-2">
                    {a.canEdit ? (
                      <InlineField
                        accountId={a.id}
                        field="tier"
                        label={`Tier for ${a.name}`}
                        value={a.tier}
                        options={[
                          ...TIERS.map((t) => ({ value: t, label: TIER_LABELS[t] })),
                          { value: "RULE", label: "Set by ARR rule" },
                        ]}
                      />
                    ) : (
                      TIER_LABELS[a.tier]
                    )}
                  </td>
                  <td className="px-2">
                    {a.canEdit ? (
                      <InlineField
                        accountId={a.id}
                        field="lifecycleStage"
                        label={`Stage for ${a.name}`}
                        value={a.lifecycleStage}
                        options={STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }))}
                      />
                    ) : (
                      STAGE_LABELS[a.lifecycleStage]
                    )}
                  </td>
                  <td className="px-2">
                    {a.canEdit && page.canChangeOwner ? (
                      <InlineField
                        accountId={a.id}
                        field="ownerMembershipId"
                        label={`Owner of ${a.name}`}
                        value={a.ownerMembershipId ?? "none"}
                        options={[
                          { value: "none", label: "No owner" },
                          ...owners.map((o) => ({ value: o.membershipId, label: o.name })),
                        ]}
                      />
                    ) : (
                      (a.ownerName ?? <span className="text-muted-foreground">No owner</span>)
                    )}
                  </td>
                  <td className="px-2 text-right">
                    {page.arrVisible ? (
                      formatArr(a.arr)
                    ) : (
                      <span className="text-muted-foreground">{RESTRICTED}</span>
                    )}
                  </td>
                  <td className="px-2">
                    {a.canEdit && a.hasContract ? (
                      <InlineField
                        accountId={a.id}
                        field="renewalDate"
                        type="date"
                        label={`Renewal date for ${a.name}`}
                        value={a.renewalDate ? a.renewalDate.toISOString().slice(0, 10) : ""}
                      />
                    ) : a.renewalDate ? (
                      formatCalendarDate(a.renewalDate)
                    ) : (
                      <span className="text-muted-foreground">
                        {a.hasContract ? "Not on file" : "No contract"}
                      </span>
                    )}
                  </td>
                  <td className="px-2">{formatDate(a.lastTouchAt, tz)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <nav aria-label="Pages" className="text-primary flex gap-4 text-sm font-medium">
        {page.prevCursor !== null ? (
          <Link href={pageHref(page.prevCursor)} className="hover:underline">
            Previous
          </Link>
        ) : null}
        {page.nextCursor !== null ? (
          <Link href={pageHref(page.nextCursor)} className="hover:underline">
            Next
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
