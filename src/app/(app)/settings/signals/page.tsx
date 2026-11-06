import type { Metadata } from "next";
import { OutsideSignalForm } from "@/components/app/outside-signal-form";
import { RuleSettingsForm } from "@/components/app/rule-settings-form";
import { scopedDb } from "@/lib/db/scoped";
import { formatDateTime } from "@/lib/format";
import { CATEGORY_WORDS } from "@/modules/signals/schemas";
import { listRuleSettings } from "@/modules/signals/service";
import { requireSettingsAccess } from "../access";

export const metadata: Metadata = { title: "Signals settings" };

/**
 * Settings › Signals (spec §6D): each rule with the four things a buyer needs to know, on/off,
 * and its thresholds. A rule whose data does not exist yet is shown as dormant and cannot be
 * switched on (D-61): it raises nothing and implies no "all clear".
 */
export default async function SignalSettingsPage() {
  const ctx = await requireSettingsAccess("healthModel:propose");
  const [rules, accounts] = await Promise.all([
    listRuleSettings(ctx),
    scopedDb(ctx).account.findMany({
      where: { lifecycleStage: { not: "LOST" }, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return (
    <div className="space-y-section max-w-4xl">
      <p className="text-muted-foreground text-sm">
        Signals are checked every night and when payments, tickets or a CSM Pulse change. Changing a
        threshold creates a new rule version; signals already raised keep the version that raised
        them.
      </p>
      <section aria-labelledby="outside" className="surface space-y-2 p-4">
        <h2 id="outside" className="text-base font-semibold">
          Add an outside signal
        </h2>
        <p className="text-muted-foreground text-sm">
          Public news about a customer&apos;s company. The source link and the event&apos;s date are
          required; news older than 30 days is shown as &quot;Reported&quot;, never as new. Many
          rows at once: Settings › Import › Outside signals.
        </p>
        <OutsideSignalForm accounts={accounts} />
      </section>
      <ul className="space-y-4" aria-label="Signal rules">
        {rules.map((r) => (
          <li key={r.id} className="surface space-y-2 p-4" data-testid={`rule-${r.ruleKey}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">{r.label}</h2>
              <span className="text-muted-foreground text-xs">
                {CATEGORY_WORDS[r.category]} ·{" "}
                {r.polarity === "OPPORTUNITY" ? "opportunity" : "risk"} · v{r.version}
                {r.updatedBy
                  ? ` · changed by ${r.updatedBy.user.name ?? r.updatedBy.user.email}, ${formatDateTime(r.updatedAt, ctx.workspace.timezone)}`
                  : ""}
                {r.dormantReason ? " · dormant" : ""}
              </span>
            </div>
            <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-3">
              <dt className="font-medium">What it means</dt>
              <dd className="sm:col-span-2">{r.meaning}</dd>
              <dt className="font-medium">How we detect it</dt>
              <dd className="sm:col-span-2">{r.howDetected}</dd>
              <dt className="font-medium">How early it appears</dt>
              <dd className="sm:col-span-2">{r.typicalLeadTime}</dd>
              <dt className="font-medium">What can make it a false alarm</dt>
              <dd className="sm:col-span-2">{r.falseAlarmCauses}</dd>
            </dl>
            {r.ruleKey === "outside_event" ? (
              <p className="text-muted-foreground text-sm">
                Outside events are added by people, with a public source link and its date.
              </p>
            ) : null}
            <RuleSettingsForm
              ruleKey={r.ruleKey}
              label={r.label}
              enabled={r.enabled}
              dormantReason={r.dormantReason}
              params={r.params as Record<string, unknown>}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
