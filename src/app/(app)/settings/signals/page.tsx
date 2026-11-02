import type { Metadata } from "next";
import { RuleSettingsForm } from "@/components/app/rule-settings-form";
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
  const rules = await listRuleSettings(ctx);
  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-muted-foreground text-sm">
        Signals are checked every night and when payments, tickets or a CSM Pulse change. Changing a
        threshold creates a new rule version; signals already raised keep the version that raised
        them.
      </p>
      <ul className="space-y-3" aria-label="Signal rules">
        {rules.map((r) => (
          <li
            key={r.id}
            className="border-border space-y-2 rounded-md border p-3"
            data-testid={`rule-${r.ruleKey}`}
          >
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
            <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="font-medium">What it means</dt>
              <dd>{r.meaning}</dd>
              <dt className="font-medium">How we detect it</dt>
              <dd>{r.howDetected}</dd>
              <dt className="font-medium">How early it appears</dt>
              <dd>{r.typicalLeadTime}</dd>
              <dt className="font-medium">What can make it a false alarm</dt>
              <dd>{r.falseAlarmCauses}</dd>
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
