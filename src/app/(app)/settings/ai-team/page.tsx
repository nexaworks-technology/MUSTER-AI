import type { Metadata, Route } from "next";
import Link from "next/link";
import { AgentSwitch } from "@/components/app/agent-switch";
import { can } from "@/lib/auth/permissions";
import { formatDateTime } from "@/lib/format";
import { aiConfigured, listAgentTeam } from "@/modules/agents/service";
import { requireSettingsAccess } from "../access";

export const metadata: Metadata = { title: "AI team" };

const STATUS_WORDS: Record<string, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  SUCCEEDED: "Succeeded",
  INVALID_OUTPUT: "Invalid output",
  UNCITED: "Uncited",
  FAILED: "Failed",
  SKIPPED: "Skipped",
};
const ACTION_WORDS: Record<string, string> = {
  NONE: "Nothing",
  DRAFTED: "Drafted",
  APPROVAL_REQUESTED: "Asked for approval",
  TASK_CREATED: "Created a task",
  NOTIFIED: "Notified",
  EXECUTED: "Wrote records",
  SENT: "Sent",
};

/** Settings › AI team (spec §6E): each agent, what it read, decided and did. */
export default async function AiTeamPage() {
  const ctx = await requireSettingsAccess("audit:view");
  const team = await listAgentTeam(ctx);
  const canSwitch = Boolean(can(ctx, "workspace:manageSettings"));
  return (
    <div className="space-y-6">
      {!aiConfigured() ? (
        <p className="rounded-md border p-3 text-sm" data-testid="ai-not-configured">
          AI is not configured (no API key). Agents do not run, and nothing is shown in their place.
        </p>
      ) : null}
      <p className="text-muted-foreground text-sm">
        Auto-send is off for every agent until plays arrive (M8): every customer email waits in
        Approvals.
      </p>
      {team.map((a) => (
        <section
          key={a.key}
          aria-labelledby={`agent-${a.key}`}
          className="space-y-2 rounded-md border p-4"
          data-testid={`agent-${a.key}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`agent-${a.key}`} className="text-base font-semibold">
              {a.key}{" "}
              <span className="text-muted-foreground text-sm font-normal">v{a.version}</span>
            </h2>
            <span className="text-sm">{a.enabled ? "On" : "Off"}</span>
            {canSwitch ? <AgentSwitch agentKey={a.key} enabled={a.enabled} /> : null}
          </div>
          <p className="text-sm">{a.description}.</p>
          <p className="text-muted-foreground text-xs">
            Model tier: {a.tier} ({a.tierReason}) · prompt {a.prompt} ·{" "}
            {a.internalOnly ? "internal only" : "customer drafts always go to Approvals"}
          </p>
          <p className="text-muted-foreground text-xs">
            Runs:{" "}
            {Object.entries(a.counts).length
              ? Object.entries(a.counts)
                  .map(([s, n]) => `${STATUS_WORDS[s] ?? s} ${n}`)
                  .join(" · ")
              : "none yet"}
          </p>
          {a.recent.length ? (
            <table className="w-full text-sm">
              <caption className="sr-only">Recent runs of {a.key}</caption>
              <thead className="text-muted-foreground text-left text-xs">
                <tr>
                  <th scope="col" className="py-1">
                    When
                  </th>
                  <th scope="col" className="py-1">
                    Account
                  </th>
                  <th scope="col" className="py-1">
                    Status
                  </th>
                  <th scope="col" className="py-1">
                    Did
                  </th>
                </tr>
              </thead>
              <tbody>
                {a.recent.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t"
                    data-testid="agent-run-row"
                    data-status={r.status}
                  >
                    <td className="py-1">
                      <Link href={`/agent-runs/${r.id}` as Route} className="underline">
                        {formatDateTime(r.createdAt, ctx.workspace.timezone)}
                      </Link>
                    </td>
                    <td className="py-1">{r.account?.name ?? "—"}</td>
                    <td className="py-1">
                      {STATUS_WORDS[r.status]}
                      {r.errorCode && r.status !== "SUCCEEDED" ? ` (${r.errorCode})` : ""}
                    </td>
                    <td className="py-1">{ACTION_WORDS[r.actionTaken]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ))}
    </div>
  );
}
