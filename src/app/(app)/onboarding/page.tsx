import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NativeSelect } from "@/components/app/native-select";
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
      <form method="get" className="surface flex flex-wrap items-end gap-3 p-4 text-sm">
        <label className="flex flex-col gap-1">
          Tier
          <NativeSelect name="tier" defaultValue={tier ?? ""}>
            <option value="">All tiers</option>
            {Object.entries(TIERS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </NativeSelect>
        </label>
        {members.length ? (
          <label className="flex flex-col gap-1">
            Owner
            <NativeSelect name="owner" defaultValue={owner ?? ""}>
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
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      {list.rows.length === 0 ? (
        <p className="text-sm">
          No accounts are onboarding{tier || owner ? " with these filters" : " in your book"}.
        </p>
      ) : (
        <div className="surface overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Accounts onboarding</caption>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Status</th>
                <th scope="col">Likely blocker</th>
                <th scope="col">Time to value</th>
                <th scope="col">Owner</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr
                  key={r.planId}

                  data-testid={`onboarding-row-${r.account.name}`}
                >
                  <td>
                    <Link
                      href={`/accounts/${r.account.id}/onboarding` as Route}
                      className="text-primary underline underline-offset-2"
                    >
                      {r.account.name}
                    </Link>
                    <span className="text-muted-foreground block text-xs">
                      {TIERS[r.account.tier as keyof typeof TIERS]} · day {r.day}
                    </span>
                  </td>
                  <td>{r.status === "STALLED" ? "Stalled" : "On track"}</td>
                  <td>{r.blocker ?? "—"}</td>
                  <td>{ttvText(r)}</td>
                  <td>{r.owner ?? "No owner"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.pages > 1 ? (
        <nav aria-label="Pages" className="flex gap-3 text-sm">
          {list.page > 1 ? (
            <Link href={href(list.page - 1)} className="text-primary underline underline-offset-2">
              Previous
            </Link>
          ) : null}
          <span>
            Page {list.page} of {list.pages}
          </span>
          {list.page < list.pages ? (
            <Link href={href(list.page + 1)} className="text-primary underline underline-offset-2">
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
