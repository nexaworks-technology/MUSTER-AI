import type { Metadata } from "next";
import { formatDateTime } from "@/lib/format";
import { JOB_STATES, jobsOverview, SCAN_LIMIT } from "@/modules/system/service";
import { requireSettingsAccess } from "../../access";
import { RetryJobButton } from "./retry-button";

export const metadata: Metadata = { title: "System jobs" };
export const dynamic = "force-dynamic";

/** Settings › System › Jobs (M12 B4, Admin only): queue counts, schedules and recent failures. */
export default async function SystemJobsPage() {
  const ctx = await requireSettingsAccess("workspace:manageSettings");
  const { queues } = await jobsOverview(ctx);
  const tz = ctx.workspace.timezone;
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground max-w-3xl text-sm">
        Background work for this workspace, plus system-wide sweeps shown as name, state and times
        only. Counts cover the latest {SCAN_LIMIT} jobs in each state. Job contents are never shown.
      </p>
      {queues.map((q) => (
        <section key={q.name} aria-labelledby={`q-${q.name}`} className="space-y-2">
          <h2 id={`q-${q.name}`} className="text-base font-semibold">
            {q.name}
          </h2>
          <dl className="flex flex-wrap gap-4 text-sm">
            {JOB_STATES.map((s) => (
              <div key={s}>
                <dt className="text-muted-foreground text-xs capitalize">{s}</dt>
                <dd className="font-medium tabular-nums">
                  {q.counts[s]}
                  {q.truncated && q.counts[s] >= SCAN_LIMIT ? "+" : ""}
                </dd>
              </div>
            ))}
          </dl>
          {q.schedules.length > 0 && (
            <ul className="text-muted-foreground text-sm">
              {q.schedules.map((s) => (
                <li key={s.key}>
                  {s.name}: {s.every}
                  {s.next ? `, next ${formatDateTime(new Date(s.next), tz)}` : ""}
                </li>
              ))}
            </ul>
          )}
          {q.recentFailed.length > 0 ? (
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th className="py-1">Job</th>
                  <th>Id</th>
                  <th>Failure</th>
                  <th>Attempts</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {q.recentFailed.map((j) => (
                  <tr key={j.id} className="border-border border-t align-top">
                    <td className="py-1">{j.name}</td>
                    <td className="font-mono text-xs">{j.id}</td>
                    <td>{j.failedReason ?? "System-wide job: details are not shown"}</td>
                    <td className="tabular-nums">{j.attempts}</td>
                    <td>{j.at ? formatDateTime(new Date(j.at), tz) : "No date"}</td>
                    <td>
                      {j.scope === "workspace" && <RetryJobButton queue={q.name} jobId={j.id} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-muted-foreground text-sm">No failed jobs.</p>
          )}
        </section>
      ))}
    </div>
  );
}
