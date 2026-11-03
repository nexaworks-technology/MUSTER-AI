import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatMoney, minorDigits } from "@/lib/money";
import {
  approveModelAction,
  backtestAction,
  createSegmentsAction,
  goLiveAction,
  keepDefaultModelAction,
  saveTierRuleAction,
  syncIntegrationAction,
} from "@/modules/setup/actions/setup";
import { getSetupState, SETUP_STEPS, type SetupStep } from "@/modules/setup/service";

export const metadata: Metadata = { title: "Set up" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const TITLES: Record<SetupStep, string> = {
  connect: "Connect",
  import: "Import",
  tiers: "Tiers and segments",
  health: "Health model",
  live: "Go live",
};

const TIER_LABEL: Record<string, string> = {
  HIGH_TOUCH: "High-touch",
  MID_TOUCH: "Mid-touch",
  LONG_TAIL: "Long-tail",
};

/**
 * /setup (spec §6O1, M5 §2): five steps, Admin only. Connect → Import → Tiers and segments →
 * Health model (the M3 back-test, approved by a person) → Go live. Works with no integration at
 * all (CSV path). M8 adds "Proposed plays" before Go live.
 */
export default async function SetupPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "workspace:manageSettings") || !can(ctx, "integrations:manage")) notFound();
  const params = await searchParams;
  const current = (SETUP_STEPS as readonly string[]).includes(one(params.step) ?? "")
    ? (one(params.step) as SetupStep)
    : "connect";
  const s = await getSetupState(ctx);
  const idx = SETUP_STEPS.indexOf(current);
  const next = SETUP_STEPS[idx + 1];
  const money = (n: number) =>
    formatMoney({
      minor: BigInt(n) * 10n ** BigInt(minorDigits(s.baseCurrency)),
      currency: s.baseCurrency,
    });

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Set up {ctx.workspace.name}</h1>
        <p className="text-muted-foreground text-sm">
          {s.setupPending
            ? "Five steps to your first real Today queue. You can leave and come back; nothing runs nightly until you go live."
            : "This workspace is live. You can still revisit any step."}
        </p>
      </div>
      <nav aria-label="Setup steps">
        <ol className="flex flex-wrap gap-2 text-sm">
          {SETUP_STEPS.map((st, n) => (
            <li key={st}>
              <Link
                href={`/setup?step=${st}`}
                aria-current={st === current ? "step" : undefined}
                className={`inline-block rounded-md border px-3 py-1 ${st === current ? "bg-primary text-primary-foreground" : ""}`}
              >
                {n + 1}. {TITLES[st]}
              </Link>
            </li>
          ))}
        </ol>
      </nav>

      {one(params.ok) ? (
        <Alert role="status">
          <AlertDescription>{one(params.ok)}</AlertDescription>
        </Alert>
      ) : null}
      {one(params.error) ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{one(params.error)}</AlertDescription>
        </Alert>
      ) : null}

      <section
        aria-labelledby="step-title"
        className="border-border space-y-4 rounded-md border p-4"
      >
        <h2 id="step-title" className="text-lg font-semibold">
          Step {idx + 1} of {SETUP_STEPS.length}: {TITLES[current]}
        </h2>

        {current === "connect" ? (
          <div className="space-y-3 text-sm">
            <p>
              Connect your CRM (HubSpot or Salesforce), billing (Stripe or Chargebee) and Slack.
              Every connection reads only. No integrations yet? Skip straight to a CSV import.
            </p>
            {s.connected.length ? (
              <ul className="list-disc pl-5">
                {s.connected.map((c) => (
                  <li key={c.provider}>{c.name}: connected</li>
                ))}
              </ul>
            ) : (
              <p>Nothing connected yet.</p>
            )}
            <div className="flex flex-wrap gap-3">
              <Link href="/settings/integrations" className="underline">
                Connect integrations
              </Link>
              <Link href="/setup?step=import" className="underline">
                Skip to CSV import
              </Link>
            </div>
          </div>
        ) : null}

        {current === "import" ? (
          <div className="space-y-3 text-sm">
            <p data-testid="setup-counts">
              So far: {s.counts.accounts} accounts, {s.counts.contacts} contacts,{" "}
              {s.counts.contracts} contracts
              {s.counts.importsDone
                ? ` (${s.counts.importsDone} CSV import${s.counts.importsDone === 1 ? "" : "s"} done)`
                : ""}
              .
            </p>
            {s.connected
              .filter((c) => c.category !== "CHAT" && c.integration)
              .map((c) => (
                <form key={c.provider} action={syncIntegrationAction.bind(null, c.integration!.id)}>
                  <Button type="submit" variant="outline" size="sm">
                    Sync {c.name} now
                  </Button>
                </form>
              ))}
            <p>
              <Link href="/settings/import" className="underline">
                Import accounts, contacts and contracts from CSV
              </Link>{" "}
              (templates are on that page; every row is previewed before anything is saved).
            </p>
          </div>
        ) : null}

        {current === "tiers" ? (
          <div className="space-y-4 text-sm">
            <p>
              Tiers follow each account&apos;s ARR in {s.baseCurrency} (accounts without a contract
              keep their tier until one is on file). Proposed bands:
            </p>
            <ul className="list-disc pl-5" data-testid="setup-tiers">
              <li>
                High-touch: {money(s.tierRule.highTouchMinArr)} and above (
                {s.tierCounts.HIGH_TOUCH ?? 0} accounts)
              </li>
              <li>
                Mid-touch: {money(s.tierRule.midTouchMinArr)} up to{" "}
                {money(s.tierRule.highTouchMinArr)} ({s.tierCounts.MID_TOUCH ?? 0} accounts)
              </li>
              <li>
                {TIER_LABEL.LONG_TAIL}: below {money(s.tierRule.midTouchMinArr)} (
                {s.tierCounts.LONG_TAIL ?? 0} accounts)
              </li>
            </ul>
            <form action={saveTierRuleAction} className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="high">High-touch from (ARR)</Label>
                <Input
                  id="high"
                  name="highTouchMinArr"
                  type="number"
                  min={1}
                  defaultValue={s.tierRule.highTouchMinArr}
                  className="w-40"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mid">Mid-touch from (ARR)</Label>
                <Input
                  id="mid"
                  name="midTouchMinArr"
                  type="number"
                  min={1}
                  defaultValue={s.tierRule.midTouchMinArr}
                  className="w-40"
                />
              </div>
              <Button type="submit" variant="outline">
                Save tier bands
              </Button>
            </form>
            <div className="space-y-2">
              <p>
                Proposed segments: High-touch accounts, Renewing in the next 90 days, Onboarding.
                {s.segments.length ? ` You have: ${s.segments.join(", ")}.` : ""}
              </p>
              <form action={createSegmentsAction}>
                <Button type="submit" variant="outline">
                  Create the proposed segments
                </Button>
              </form>
            </div>
          </div>
        ) : null}

        {current === "health" ? (
          <div className="space-y-3 text-sm">
            <p>
              We back-test the health model on your own renewed and churned accounts, then you
              approve it. The numbers below come from the scoring engine, not from AI.
            </p>
            {s.health.active?.sentence ? (
              <p data-testid="setup-active-model">
                Active: v{s.health.active.version}. {s.health.active.sentence}
              </p>
            ) : null}
            {s.health.proposal ? (
              <div
                className="border-border space-y-2 rounded-md border p-3"
                data-testid="setup-proposal"
              >
                <p className="font-medium">Proposed: v{s.health.proposal.version}</p>
                <p>
                  {s.health.proposal.sentence ?? "No back-test result is stored for this proposal."}
                </p>
                {s.health.proposal.caveat ? (
                  <p className="text-muted-foreground">{s.health.proposal.caveat}</p>
                ) : null}
                {s.health.proposal.caveat ? (
                  s.health.keptDefault ? (
                    <p>You kept the default model for now.</p>
                  ) : (
                    <form action={keepDefaultModelAction}>
                      <Button type="submit">Keep the default model for now</Button>
                    </form>
                  )
                ) : (
                  <form action={approveModelAction.bind(null, s.health.proposal.id)}>
                    <Button type="submit">Approve this model</Button>
                  </form>
                )}
              </div>
            ) : s.health.backtesting ? (
              <p>The back-test is running. Refresh in a few seconds.</p>
            ) : (
              <form action={backtestAction}>
                <Button type="submit">Run the back-test</Button>
              </form>
            )}
            <p>
              <Link href="/settings/health-model" className="underline">
                See the details or edit weights in Settings › Health model
              </Link>
            </p>
          </div>
        ) : null}

        {current === "live" ? (
          <div className="space-y-3 text-sm">
            <ul className="list-disc pl-5">
              <li>{s.counts.accounts} accounts in the workspace</li>
              <li>
                Health model:{" "}
                {s.health.active?.sentence
                  ? `v${s.health.active.version} approved`
                  : "not approved yet (step 4)"}
              </li>
              <li>
                Integrations:{" "}
                {s.connected.length ? s.connected.map((c) => c.name).join(", ") : "none (CSV only)"}
              </li>
            </ul>
            {s.setupPending ? (
              <form action={goLiveAction}>
                <Button type="submit">Go live</Button>
              </form>
            ) : (
              <p>
                You are live.{" "}
                <Link href="/today" className="underline">
                  Open Today
                </Link>
              </p>
            )}
          </div>
        ) : null}

        {next ? (
          <p>
            <Link href={`/setup?step=${next}`} className="underline">
              Next: {TITLES[next]}
            </Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}
