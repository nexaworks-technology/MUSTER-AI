import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";
import { DataListAvatar } from "@/components/app/data-list";
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Accounts</h1>
          <p className="text-muted-foreground text-xs mt-0.5">
            Portfolio accounts across health, lifecycle stages, and commercial owners.
          </p>
        </div>
      </div>

      {/* R1: Filter bar as one card with an icon search field */}
      <form
        method="get"
        className="surface rounded-xl border border-border/80 p-4 shadow-xs flex flex-wrap items-end gap-3"
        role="search"
        aria-label="Filter accounts"
      >
        <div className="space-y-1">
          <label htmlFor="q" className="text-muted-foreground block text-xs font-medium">
            Search
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground"
            />
            <Input
              id="q"
              name="q"
              defaultValue={query.q ?? ""}
              placeholder="Name or domain"
              className="w-56 pl-8 h-8 text-xs"
            />
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="tier" className="text-muted-foreground block text-xs font-medium">
            Tier
          </label>
          <NativeSelect id="tier" name="tier" defaultValue={query.tier ?? ""} className="h-8 text-xs">
            <option value="">All tiers</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {TIER_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="stage" className="text-muted-foreground block text-xs font-medium">
            Stage
          </label>
          <NativeSelect id="stage" name="stage" defaultValue={query.stage ?? ""} className="h-8 text-xs">
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="health" className="text-muted-foreground block text-xs font-medium">
            Health
          </label>
          <NativeSelect id="health" name="health" defaultValue={query.health ?? ""} className="h-8 text-xs">
            <option value="">Any health</option>
            {HEALTH_LEVELS.map((h) => (
              <option key={h} value={h}>
                {RISK_WORDS[h]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="owner" className="text-muted-foreground block text-xs font-medium">
            Owner
          </label>
          <NativeSelect id="owner" name="owner" defaultValue={query.owner ?? ""} className="h-8 text-xs">
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
          <label htmlFor="segment" className="text-muted-foreground block text-xs font-medium">
            Segment
          </label>
          <NativeSelect id="segment" name="segment" defaultValue={query.segment ?? ""} className="h-8 text-xs">
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
          <label htmlFor="sort" className="text-muted-foreground block text-xs font-medium">
            Sort by
          </label>
          <NativeSelect id="sort" name="sort" defaultValue={query.sort} className="h-8 text-xs">
            <option value="name">Name</option>
            {page.arrVisible ? <option value="arr">ARR</option> : null}
            <option value="renewal">Renewal date</option>
            <option value="lastTouch">Last touch</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="dir" className="text-muted-foreground block text-xs font-medium">
            Order
          </label>
          <NativeSelect id="dir" name="dir" defaultValue={query.dir} className="h-8 text-xs">
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline" size="sm" className="h-8 shadow-2xs font-medium">
          Apply
        </Button>
        <Link href="/accounts" className="text-primary py-1.5 text-xs font-medium hover:underline">
          Clear
        </Link>
      </form>

      {page.segmentMissing ? (
        <p
          role="alert"
          className="bg-danger-soft text-danger-soft-foreground rounded-lg border border-danger-soft-foreground/20 px-3.5 py-2.5 text-xs"
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
          className="bg-danger-soft text-danger-soft-foreground rounded-lg border border-danger-soft-foreground/20 px-3.5 py-2.5 text-xs"
        >
          Some filters were not valid and were ignored.
        </p>
      ) : null}

      <p className="text-muted-foreground text-xs" aria-live="polite">
        {page.total === 0
          ? "No accounts match these filters."
          : `Showing ${page.offset + 1}–${page.offset + page.rows.length} of ${page.total}`}
      </p>

      {/* R1: Accounts as a premium data grid */}
      {page.rows.length > 0 ? (
        <div
          className="surface rounded-xl border border-border/80 shadow-xs overflow-hidden"
          role="region"
          aria-label="Accounts table"
          tabIndex={0}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-224 text-sm border-collapse">
              <caption className="sr-only">Accounts</caption>
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-xs border-b border-border/80">
                <tr className="text-muted-foreground text-xs font-medium">
                  <th scope="col" className="px-3.5 py-2.5 text-left font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">
                    Health
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">
                    CSM Pulse
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">
                    Tier
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">
                    Stage
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">
                    Owner
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">
                    ARR
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">
                    Renewal date
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">
                    Last touch
                  </th>
                  <th scope="col" className="w-16 px-3 py-2.5 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40 text-xs">
                {page.rows.map((a) => (
                  <tr key={a.id} className="group hover:bg-muted/40 transition-colors">
                    {/* Monogram + Name/Domain stacked */}
                    <td className="px-3.5 py-2">
                      <div className="flex items-center gap-2.5">
                        <DataListAvatar name={a.name} size="sm" />
                        <div className="min-w-0">
                          <Link
                            href={`/accounts/${a.id}`}
                            className="font-medium text-foreground hover:text-primary hover:underline truncate block text-xs sm:text-sm"
                          >
                            {a.name}
                          </Link>
                          {a.domain ? (
                            <div className="text-muted-foreground text-[11px] truncate">
                              {a.domain}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>

                    {/* Health as Score + StatusPill */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      {(() => {
                        const h = health.get(a.id);
                        if (!h?.riskLevel)
                          return (
                            <span className="text-muted-foreground text-xs">
                              {a.lifecycleStage === "LOST" ? "Not scored (lost account)" : "Not scored yet"}
                            </span>
                          );
                        return (
                          <Link
                            href={`/accounts/${a.id}/health`}
                            className="inline-flex items-center gap-2 hover:opacity-85 transition-opacity"
                            aria-label={`Health ${h.overall ?? "not enough data"}, ${RISK_WORDS[h.riskLevel]}: why`}
                          >
                            <span className="font-semibold tabular-nums text-foreground text-xs">
                              {h.overall === null ? "—" : h.overall.toFixed(0)}
                            </span>
                            <RiskBadge level={h.riskLevel} />
                          </Link>
                        );
                      })()}
                    </td>

                    {/* CSM Pulse as segmented control */}
                    <td className="px-3 py-2">
                      {(() => {
                        const h = health.get(a.id);
                        return (
                          <div className="flex flex-col gap-1">
                            {h?.pulse?.valid ? (
                              <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
                                <span className="font-medium text-foreground">
                                  {PULSE_WORDS[h.pulse.value]}
                                </span>
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

                    {/* Tier as data */}
                    <td className="px-3 py-2 whitespace-nowrap">
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
                        <span className="text-muted-foreground font-normal">
                          {TIER_LABELS[a.tier]}
                        </span>
                      )}
                    </td>

                    {/* Stage as data */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.canEdit ? (
                        <InlineField
                          accountId={a.id}
                          field="lifecycleStage"
                          label={`Stage for ${a.name}`}
                          value={a.lifecycleStage}
                          options={STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }))}
                        />
                      ) : (
                        <span className="text-muted-foreground font-normal">
                          {STAGE_LABELS[a.lifecycleStage]}
                        </span>
                      )}
                    </td>

                    {/* Owner as data */}
                    <td className="px-3 py-2 whitespace-nowrap">
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
                        (a.ownerName ?? <span className="text-muted-foreground font-normal">No owner</span>)
                      )}
                    </td>

                    {/* ARR */}
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium text-foreground">
                      {page.arrVisible ? (
                        formatArr(a.arr)
                      ) : (
                        <span className="text-muted-foreground font-normal">{RESTRICTED}</span>
                      )}
                    </td>

                    {/* Renewal date as data */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.canEdit && a.hasContract ? (
                        <InlineField
                          accountId={a.id}
                          field="renewalDate"
                          type="date"
                          label={`Renewal date for ${a.name}`}
                          value={a.renewalDate ? a.renewalDate.toISOString().slice(0, 10) : ""}
                        />
                      ) : a.renewalDate ? (
                        <span className="tabular-nums text-foreground">
                          {formatCalendarDate(a.renewalDate)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground font-normal">
                          {a.hasContract ? "Not on file" : "No contract"}
                        </span>
                      )}
                    </td>

                    {/* Last touch */}
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {formatDate(a.lastTouchAt, tz)}
                    </td>

                    {/* Row hover with Open action */}
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Link
                        href={`/accounts/${a.id}`}
                        className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        <span>Open</span>
                        <ArrowRight aria-hidden="true" className="size-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Styled pagination footer */}
      <nav
        aria-label="Pages"
        className="flex items-center justify-between border-t border-border/60 pt-4 text-xs font-medium text-muted-foreground"
      >
        <div>
          {page.total > 0
            ? `Showing ${page.offset + 1}–${page.offset + page.rows.length} of ${page.total}`
            : null}
        </div>
        <div className="flex items-center gap-3">
          {page.prevCursor !== null ? (
            <Link
              href={pageHref(page.prevCursor)}
              className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
            >
              <span>← Previous</span>
            </Link>
          ) : null}
          {page.nextCursor !== null ? (
            <Link
              href={pageHref(page.nextCursor)}
              className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
            >
              <span>Next →</span>
            </Link>
          ) : null}
        </div>
      </nav>
    </div>
  );
}
