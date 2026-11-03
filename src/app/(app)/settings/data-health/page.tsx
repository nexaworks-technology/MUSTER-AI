import type { Metadata } from "next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { retryJobAction } from "@/modules/integrations/actions/data-health";
import { getDataHealth } from "@/modules/integrations/service";
import { requireSettingsAccess } from "../access";

export const metadata: Metadata = { title: "Data health" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Settings › Data health (ARCHITECTURE §1.2): background work that failed after all its tries,
 * syncs that failed and webhook events that could not be processed, in plain words.
 */
export default async function DataHealthPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requireSettingsAccess("data:import");
  const params = await searchParams;
  const { jobs, syncs, webhooks } = await getDataHealth(ctx);
  const tz = ctx.workspace.timezone;
  const nothing = jobs.length + syncs.length + webhooks.length === 0;
  return (
    <div className="max-w-4xl space-y-6">
      <section aria-labelledby="dh" className="space-y-2">
        <h2 id="dh" className="text-base font-semibold">
          Data health
        </h2>
        <p className="text-muted-foreground text-sm">
          Work that did not finish in the last 30 days. Each item tries again by itself a few times;
          only what still failed after that is listed here.
        </p>
        {params.retried ? (
          <Alert role="status">
            <AlertDescription>Queued to run again. Refresh in a moment.</AlertDescription>
          </Alert>
        ) : null}
        {params.error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>That item is no longer in the failed list.</AlertDescription>
          </Alert>
        ) : null}
        {nothing ? <p className="text-sm">Nothing has failed. Everything ran.</p> : null}
      </section>

      {jobs.length ? (
        <section aria-labelledby="dh-jobs" className="space-y-2">
          <h3 id="dh-jobs" className="font-semibold">
            Background work that stopped
          </h3>
          <ul className="divide-border border-border divide-y rounded-md border text-sm">
            {jobs.map((j) => (
              <li
                key={`${j.queue}:${j.jobId}`}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
              >
                <span>
                  {j.label} failed after {j.attempts} {j.attempts === 1 ? "try" : "tries"}
                  {j.failedAt ? ` on ${formatDateTime(j.failedAt, tz)}` : ""}. It will not try again
                  by itself.
                </span>
                <form action={retryJobAction.bind(null, j.queue, j.jobId)}>
                  <Button type="submit" size="sm" variant="outline">
                    Run again
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {syncs.length ? (
        <section aria-labelledby="dh-syncs" className="space-y-2">
          <h3 id="dh-syncs" className="font-semibold">
            Syncs that failed
          </h3>
          <ul className="divide-border border-border divide-y rounded-md border text-sm">
            {syncs.map((s) => (
              <li key={s.id} className="p-3">
                {s.provider}, {formatDateTime(s.startedAt, tz)}: {s.errorPlain}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {webhooks.length ? (
        <section aria-labelledby="dh-hooks" className="space-y-2">
          <h3 id="dh-hooks" className="font-semibold">
            Events that could not be processed
          </h3>
          <ul className="divide-border border-border divide-y rounded-md border text-sm">
            {webhooks.map((h) => (
              <li key={h.id} className="p-3">
                {h.provider} {h.eventType}, received {formatDateTime(h.receivedAt, tz)}:{" "}
                {h.errorPlain}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
