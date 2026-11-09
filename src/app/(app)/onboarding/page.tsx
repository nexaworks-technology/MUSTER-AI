import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import { NativeSelect } from "@/components/app/native-select";
import { DataListAvatar, DataListCard } from "@/components/app/data-list";
import { StatusPill } from "@/components/app/status-pill";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listMembers } from "@/modules/settings/service";
import { listOnboarding, type OnboardingRow } from "@/modules/onboarding/service";

export const metadata: Metadata = { title: "Onboarding" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const TIERS = { HIGH_TOUCH: "High-touch", MID_TOUCH: "Mid-touch", LONG_TAIL: "Long-tail" } as const;

function ttvText(r: OnboardingRow) {
  const t = r.ttv;
  if (!t || t.state === "NO_DEFINITION") return "No value definition for this plan";
  if (t.state === "REACHED") return `Value reached on day ${t.days}`;
  const typical = t.cohort
    ? `similar accounts reach value by day ${t.cohort.medianDays}`
    : `plan target day ${t.ownTargetDays}`;
  return `Day ${t.days}${t.verdict === "LATE" ? " (late)" : ""}: ${typical}`;
}

/**
 * Onboarding (spec §5, §6G1): every account with an open plan in the member's book, stalled first,
 * with the likely blocker in plain words and time to value against similar accounts.
 */
export default async function OnboardingPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();
  const params = await searchParams;
  const tier = one(params.tier);
  const owner = one(params.owner);
  const page = Number(one(params.page) ?? 1) || 1;
  const list = await listOnboarding(ctx, {
    tier: tier || undefined,
    owner: owner || undefined,
    page,
  });
  // The owner filter is for Admins (who see every member); a CSM's list is their own book.
  const members = can(ctx, "workspace:manageUsers") ? await listMembers(ctx) : [];
  const href = (p: number) => {
    const q = new URLSearchParams({
      ...(tier ? { tier } : {}),
      ...(owner ? { owner } : {}),
      page: String(p),
    });
    return `/onboarding?${q.toString()}` as Route;
  };

  return (
    <div className="space-y-section">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Onboarding</h1>
        <p className="text-muted-foreground text-sm">
          Every new customer on a plan: where each one is stuck and what would unblock it. Stalled
          accounts come first.
        </p>
      </div>
      <DataListCard className="p-3">
        <form method="get" className="flex flex-wrap items-center gap-3 text-xs sm:text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground font-medium">Tier</span>
            <NativeSelect name="tier" defaultValue={tier ?? ""} className="h-8 text-xs">
              <option value="">All tiers</option>
              {Object.entries(TIERS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          </label>
          {members.length ? (
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground font-medium">Owner</span>
              <NativeSelect name="owner" defaultValue={owner ?? ""} className="h-8 text-xs">
                <option value="">Everyone</option>
                {members
                  .filter((m) => m.status === "ACTIVE")
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.user.name ?? m.user.email}
                    </option>
                  ))}
              </NativeSelect>
            </label>
          ) : null}
          <Button type="submit" variant="outline" size="sm" className="h-8">
            Filter
          </Button>
        </form>
      </DataListCard>

      {list.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No accounts are onboarding{tier || owner ? " with these filters" : " in your book"}.
        </p>
      ) : (
        <DataListCard>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Accounts onboarding</caption>
              <thead>
                <tr className="border-border bg-muted/60 text-muted-foreground border-b text-[11px] font-semibold tracking-wider uppercase sticky top-0 z-10 backdrop-blur-sm">
                  <th scope="col" className="px-4 py-3">Account</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">Likely blocker</th>
                  <th scope="col" className="px-4 py-3">Time to value</th>
                  <th scope="col" className="px-4 py-3">Owner</th>
                  <th scope="col" className="px-4 py-3 w-16 sr-only">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {list.rows.map((r) => (
                  <tr
                    key={r.planId}
                    className="group hover:bg-muted/40 transition-colors"
                    data-testid={`onboarding-row-${r.account.name}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <DataListAvatar name={r.account.name} size="sm" className="shrink-0" />
                        <div>
                          <Link
                            href={`/accounts/${r.account.id}/onboarding` as Route}
                            className="font-medium text-foreground hover:underline"
                          >
                            {r.account.name}
                          </Link>
                          <span className="text-muted-foreground block text-xs">
                            {TIERS[r.account.tier as keyof typeof TIERS]} · day {r.day}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill
                        variant={r.status === "STALLED" ? "danger" : "success"}
                        size="sm"
                      >
                        {r.status === "STALLED" ? "Stalled" : "On track"}
                      </StatusPill>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs leading-relaxed max-w-xs">{r.blocker ?? "—"}</td>
                    <td className="px-4 py-3 text-xs leading-relaxed">{ttvText(r)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{r.owner ?? "No owner"}</td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/accounts/${r.account.id}/onboarding` as Route}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-primary hover:text-primary/80 inline-flex items-center text-xs font-medium"
                      >
                        <span>Open</span>
                        <ArrowUpRight className="size-3.5 ml-0.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataListCard>
      )}
      {list.pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center justify-between text-xs sm:text-sm font-medium">
          <div>
            {list.page > 1 ? (
              <Link href={href(list.page - 1)} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                <ArrowLeft className="size-3.5" />
                Previous
              </Link>
            ) : null}
          </div>
          <span className="text-muted-foreground text-xs">
            Page {list.page} of {list.pages}
          </span>
          <div>
            {list.page < list.pages ? (
              <Link href={href(list.page + 1)} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                Next
                <ArrowRight className="size-3.5" />
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
