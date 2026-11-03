import type { Metadata } from "next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { archiveTemplateAction, saveTemplateAction } from "@/modules/onboarding/actions/onboarding";
import { listTemplates, type Condition } from "@/modules/onboarding/service";
import { requireSettingsAccess } from "../access";

export const metadata: Metadata = { title: "Onboarding templates" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const TIERS = { HIGH_TOUCH: "High-touch", MID_TOUCH: "Mid-touch", LONG_TAIL: "Long-tail" } as const;
const METRICS = [
  ["featureUsed", "A feature used on N days"],
  ["keyFeaturesUsed", "N key features used"],
  ["activeSeatShare", "N% of seats active"],
  ["activeUsers", "N active users"],
] as const;

type Template = Awaited<ReturnType<typeof listTemplates>>[number];

const stepsText = (t: Template | null) =>
  t
    ? t.steps
        .map((s) => `${s.title} | ${s.ownerSide === "US" ? "us" : "customer"} | day ${s.dueDay}`)
        .join("\n")
    : "";

const numberOf = (c: Condition | undefined) =>
  !c
    ? ""
    : c.metric === "featureUsed"
      ? c.minDays
      : c.metric === "activeSeatShare"
        ? Math.round(c.min * 100)
        : c.min;

function TemplateForm({ t }: { t: Template | null }) {
  const p = t ? `t-${t.id}` : "new";
  return (
    <form action={saveTemplateAction.bind(null, t?.id ?? null)} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${p}-name`}>Name</Label>
          <Input id={`${p}-name`} name="name" defaultValue={t?.name ?? ""} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${p}-days`}>First value expected by day</Label>
          <Input
            id={`${p}-days`}
            name="targetDays"
            type="number"
            min={1}
            defaultValue={t?.targetDays ?? 60}
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${p}-tier`}>For tier</Label>
          <select
            id={`${p}-tier`}
            name="forTier"
            defaultValue={t?.forTier ?? ""}
            className="border-input h-9 w-full rounded-md border px-2"
          >
            <option value="">Any tier</option>
            {Object.entries(TIERS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${p}-plan`}>For plan (optional)</Label>
          <Input id={`${p}-plan`} name="forPlan" defaultValue={t?.forPlan ?? ""} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${p}-steps`}>Steps, one per line: Title | us or customer | day</Label>
        <textarea
          id={`${p}-steps`}
          name="steps"
          rows={6}
          defaultValue={stepsText(t)}
          className="border-input w-full rounded-md border p-2 font-mono text-sm"
          required
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          First value means (all must hold; from metrics the product measures)
        </legend>
        {[0, 1, 2].map((i) => {
          const c = t?.valueDefinition[i];
          return (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col text-xs">
                Metric
                <select
                  name={`metric${i}`}
                  defaultValue={c?.metric ?? ""}
                  className="border-input h-9 rounded-md border px-2 text-sm"
                >
                  <option value="">(none)</option>
                  {METRICS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col text-xs">
                N
                <input
                  name={`value${i}`}
                  type="number"
                  min={0}
                  defaultValue={numberOf(c)}
                  className="border-input h-9 w-20 rounded-md border px-2 text-sm"
                />
              </label>
              <label className="flex flex-col text-xs">
                Weekdays in a row
                <input
                  name={`days${i}`}
                  type="number"
                  min={1}
                  defaultValue={c && "days" in c ? c.days : 1}
                  className="border-input h-9 w-20 rounded-md border px-2 text-sm"
                />
              </label>
              <label className="flex flex-col text-xs">
                Feature key
                <input
                  name={`feature${i}`}
                  defaultValue={c?.metric === "featureUsed" ? c.featureKey : ""}
                  className="border-input h-9 w-40 rounded-md border px-2 text-sm"
                />
              </label>
            </div>
          );
        })}
      </fieldset>
      <Button type="submit">{t ? "Save template" : "Add template"}</Button>
    </form>
  );
}

/** Settings › Onboarding templates (spec §6G1): Admins and CS Leaders. Every change is audited. */
export default async function OnboardingTemplatesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const ctx = await requireSettingsAccess("plays:publish");
  const q = await searchParams;
  const templates = await listTemplates(ctx);
  return (
    <div className="max-w-4xl space-y-6">
      <section aria-labelledby="tpl" className="space-y-2">
        <h2 id="tpl" className="text-base font-semibold">
          Onboarding templates
        </h2>
        <p className="text-muted-foreground text-sm">
          A new customer&apos;s plan starts from the template for their plan or tier. Steps are done
          by a person, or by the product usage a step names. Nothing is marked done because a date
          passed.
        </p>
        {one(q.ok) ? (
          <Alert role="status">
            <AlertDescription>{one(q.ok)}</AlertDescription>
          </Alert>
        ) : null}
        {one(q.error) ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{one(q.error)}</AlertDescription>
          </Alert>
        ) : null}
      </section>
      <ul className="space-y-4">
        {templates.map((t) => (
          <li key={t.id} className="border-border space-y-2 rounded-md border p-4">
            <h3 className="font-semibold">{t.name}</h3>
            <p className="text-sm">
              {t.forTier ? TIERS[t.forTier] : "Any tier"}
              {t.forPlan ? ` · ${t.forPlan} plan` : ""} · {t.steps.length} steps · first value by
              day {t.targetDays}
            </p>
            <p className="text-sm">
              {t.valueText
                ? `First value means: ${t.valueText}.`
                : "No value definition: time to value is not measured."}
            </p>
            <details>
              <summary className="cursor-pointer text-sm">Edit</summary>
              <div className="mt-3">
                <TemplateForm t={t} />
              </div>
            </details>
            <form action={archiveTemplateAction.bind(null, t.id)}>
              <Button type="submit" variant="ghost" size="sm">
                Archive
              </Button>
            </form>
          </li>
        ))}
      </ul>
      <details className="border-border rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">Add a template</summary>
        <div className="mt-3">
          <TemplateForm t={null} />
        </div>
      </details>
    </div>
  );
}
