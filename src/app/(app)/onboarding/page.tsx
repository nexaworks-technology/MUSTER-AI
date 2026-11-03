import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
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
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Onboarding</h1>
      <p className="text-muted-foreground text-sm">
        Every new customer on a plan: where each one is stuck and what would unblock it. Stalled
        accounts come first.
      </p>
      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          Tier
          <select
            name="tier"
            defaultValue={tier ?? ""}
            className="border-input rounded-md border px-2 py-1"
          >
            <option value="">All tiers</option>
            {Object.entries(TIERS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {members.length ? (
          <label className="flex flex-col gap-1">
            Owner
            <select
              name="owner"
              defaultValue={owner ?? ""}
              className="border-input rounded-md border px-2 py-1"
            >
              <option value="">Everyone</option>
              {members
                .filter((m) => m.status === "ACTIVE")
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.user.name ?? m.user.email}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        <button type="submit" className="border-input rounded-md border px-3 py-1">
          Filter
        </button>
      </form>

      {list.rows.length === 0 ? (
        <p className="text-sm">
          No accounts are onboarding{tier || owner ? " with these filters" : " in your book"}.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Accounts onboarding</caption>
            <thead>
              <tr className="border-border border-b">
                <th scope="col" className="py-2 pr-3">
                  Account
                </th>
                <th scope="col" className="py-2 pr-3">
                  Status
                </th>
                <th scope="col" className="py-2 pr-3">
                  Likely blocker
                </th>
                <th scope="col" className="py-2 pr-3">
                  Time to value
                </th>
                <th scope="col" className="py-2 pr-3">
                  Owner
                </th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr
                  key={r.planId}
                  className="border-border border-b"
                  data-testid={`onboarding-row-${r.account.name}`}
                >
                  <td className="py-2 pr-3">
                    <Link
                      href={`/accounts/${r.account.id}/onboarding` as Route}
                      className="underline"
                    >
                      {r.account.name}
                    </Link>
                    <span className="text-muted-foreground block text-xs">
                      {TIERS[r.account.tier as keyof typeof TIERS]} · day {r.day}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{r.status === "STALLED" ? "Stalled" : "On track"}</td>
                  <td className="py-2 pr-3">{r.blocker ?? "—"}</td>
                  <td className="py-2 pr-3">{ttvText(r)}</td>
                  <td className="py-2 pr-3">{r.owner ?? "No owner"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.pages > 1 ? (
        <nav aria-label="Pages" className="flex gap-3 text-sm">
          {list.page > 1 ? <Link href={href(list.page - 1)}>Previous</Link> : null}
          <span>
            Page {list.page} of {list.pages}
          </span>
          {list.page < list.pages ? <Link href={href(list.page + 1)}>Next</Link> : null}
        </nav>
      ) : null}
    </div>
  );
}
