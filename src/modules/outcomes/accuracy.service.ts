import { z } from "zod";
import { requirePermission } from "@/lib/auth/permissions";
import { addDays, businessClock, type Clock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { bookWhere, type Actor } from "@/modules/accounts/service";
import { getSettingsData } from "@/modules/settings/service";
import { updateRuleSettings } from "@/modules/signals/service";
import {
  buildAccuracy,
  type Accuracy,
  type AccuracyApproval,
  type AccuracyFlag,
  type AccuracyThresholds,
} from "./accuracy";

/**
 * M11 S5: loads the AI accuracy view in a fixed number of queries (workspace-scoped through
 * `scopedDb`, book-scoped for a CSM, `reports:view`). Reads outcome records, their signal's status
 * and agent, and decided approvals; it never reads a health snapshot. Tune and Kill are thin,
 * permission-checked wrappers over the existing audited `updateRuleSettings` (M11 rule 4: this slice
 * measures the models, it changes no default, weight, param or prompt).
 */
export interface AccuracyView extends Accuracy {
  windowDays: number;
  since: Date;
  /** Names of the accounts behind the items (already loaded with them). */
  accountNames: Record<string, string>;
  thresholds: AccuracyThresholds;
}

export interface AccuracyQuery {
  windowDays?: number;
}

const d90Schema = z.object({
  status: z.string(),
  actionTaken: z.enum(["ACTED", "IGNORED"]),
  healthAtCheckpoint: z.object({ riskLevel: z.string() }).nullable().default(null),
});

export async function loadAccuracy(
  actor: Actor,
  query: AccuracyQuery = {},
  clock: Clock = businessClock,
): Promise<AccuracyView> {
  const grant = requirePermission(actor, "reports:view");
  const db = scopedDb(actor);
  const settings = (await getSettingsData(actor.workspaceId)).accuracy;
  const windowDays = query.windowDays ?? settings.windowDays;
  const thresholds: AccuracyThresholds = {
    criesWolfRate: settings.criesWolfRate,
    criesWolfMinDetermined: settings.criesWolfMinDetermined,
  };
  const now = clock();
  const today = now.toISOString().slice(0, 10);
  // Judged on the same basis as the ledger: risks whose 90-day check date fell in the window
  // (a flag raised in the last 90 days cannot have an outcome yet, D-167).
  const since = new Date(`${addDays(today, -windowDays)}T00:00:00Z`);
  const flaggedFrom = new Date(`${addDays(today, -windowDays - 90)}T00:00:00Z`);
  const flaggedTo = new Date(`${addDays(today, -90)}T00:00:00Z`);
  const book = bookWhere(actor, grant.scope);

  const [records, approvals] = await Promise.all([
    db.outcomeRecord.findMany({
      where: { flagType: "RISK", flaggedAt: { gte: flaggedFrom, lt: flaggedTo }, account: book },
      select: {
        id: true,
        accountId: true,
        flaggedAt: true,
        signalId: true,
        account: { select: { name: true } },
        flagType: true,
        isTrueAlarm: true,
        d90Outcome: true,
        signal: { select: { ruleKey: true, status: true } },
        agentRun: { select: { agentKey: true } },
      },
    }),
    db.approval.findMany({
      where: {
        proposedByAgentRunId: { not: null },
        status: { in: ["APPROVED", "EDITED_APPROVED", "REJECTED"] },
        createdAt: { gte: since },
        ...(grant.scope === "ALL" ? {} : { account: book }),
      },
      select: {
        id: true,
        accountId: true,
        account: { select: { name: true } },
        status: true,
        proposedByRun: { select: { agentKey: true } },
      },
    }),
  ]);

  const flags: AccuracyFlag[] = records.map((r) => {
    const d90 = r.d90Outcome === null ? null : d90Schema.safeParse(r.d90Outcome);
    return {
      flagType: r.flagType as "RISK" | "OPPORTUNITY",
      signalStatus: r.signal?.status ?? null,
      isTrueAlarm: r.isTrueAlarm,
      d90: d90?.success ? (d90.data as AccuracyFlag["d90"]) : null,
      ruleKey: r.signal?.ruleKey ?? null,
      agentKey: r.agentRun?.agentKey ?? null,
      outcomeRecordId: r.id,
      signalId: r.signalId,
      accountId: r.accountId,
      flaggedAt: r.flaggedAt,
    };
  });
  const decided: AccuracyApproval[] = approvals.flatMap((a) =>
    a.proposedByRun
      ? [
          {
            approvalId: a.id,
            accountId: a.accountId,
            agentKey: a.proposedByRun.agentKey,
            status: a.status,
          },
        ]
      : [],
  );
  const accountNames: Record<string, string> = {};
  for (const r of records) accountNames[r.accountId] = r.account.name;
  for (const a of approvals)
    if (a.accountId && a.account) accountNames[a.accountId] = a.account.name;
  return {
    ...buildAccuracy(flags, decided, thresholds),
    windowDays,
    since,
    thresholds,
    accountNames,
  };
}

/** Tune: the user edits a cries-wolf rule's numeric thresholds (merged onto its current params). */
export async function tuneRule(actor: Actor, ruleKey: string, numeric: Record<string, number>) {
  requirePermission(actor, "healthModel:propose");
  const row = await scopedDb(actor).signalRule.findFirst({ where: { ruleKey } });
  const current = (row?.params ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = structuredClone(current);
  for (const [path, value] of Object.entries(numeric)) {
    let o = merged;
    const segs = path.split(".");
    for (const seg of segs.slice(0, -1)) o = (o[seg] ??= {}) as Record<string, unknown>;
    o[segs.at(-1)!] = value;
  }
  return updateRuleSettings(actor, ruleKey, { params: merged });
}

/** Kill: switch the rule off. Audited by `updateRuleSettings`; nothing is deleted. */
export async function killRule(actor: Actor, ruleKey: string) {
  return updateRuleSettings(actor, ruleKey, { enabled: false });
}
