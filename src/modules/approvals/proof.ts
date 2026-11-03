import type { ScopedDb } from "@/lib/db/scoped";
import { describeSource, sourceLookups } from "@/modules/health/service";

/**
 * Proof links for approvals and agent runs (Rule 1): every source becomes a link to the exact
 * record, or says plainly that the record is gone. Signals, health reasons, agent runs and drafts
 * are resolved here; account records reuse the Health "Why" resolver (one batched lookup each).
 */
export interface ProofRef {
  sourceType: string;
  sourceId: string;
  label?: string;
}

export interface ProofLink {
  sourceType: string;
  sourceId: string;
  label: string;
  href: string | null;
  missing: boolean;
}

const HEALTH_TYPES = new Set([
  "UsageDaily",
  "UserUsageDaily",
  "FeatureUsageDaily",
  "Contract",
  "Invoice",
  "RevenueEvent",
  "Ticket",
  "Message",
  "Contact",
  "StakeholderRole",
  "CsmPulse",
]);

export function parseProof(raw: unknown): ProofRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) =>
    p && typeof p === "object" && typeof p.sourceType === "string" && typeof p.sourceId === "string"
      ? [
          {
            sourceType: p.sourceType,
            sourceId: p.sourceId,
            label: typeof p.label === "string" ? p.label : undefined,
          },
        ]
      : [],
  );
}

export async function resolveProof(
  db: ScopedDb,
  accountId: string,
  refs: ProofRef[],
): Promise<ProofLink[]> {
  const ids = (t: string) => refs.filter((r) => r.sourceType === t).map((r) => r.sourceId);
  // M6: onboarding and feature records are read only when a proof cites them, so the reads an
  // approval made before M6 are unchanged.
  const [signals, reasons, runs, accounts, outbound, look, plans, steps, features] =
    await Promise.all([
      db.signal.findMany({
        where: { id: { in: ids("Signal") } },
        select: { id: true, title: true, accountId: true },
      }),
      db.healthReason.findMany({
        where: { id: { in: ids("HealthReason") } },
        select: { id: true, message: true, snapshot: { select: { accountId: true } } },
      }),
      db.agentRun.findMany({
        where: { id: { in: ids("AgentRun") } },
        select: { id: true, agentKey: true },
      }),
      db.account.findMany({
        where: { id: { in: ids("Account") } },
        select: { id: true, name: true },
      }),
      db.outboundMessage.findMany({
        where: { id: { in: ids("OutboundMessage") } },
        select: { id: true, subject: true },
      }),
      sourceLookups(
        db,
        refs.filter((r) => HEALTH_TYPES.has(r.sourceType)),
      ),
      ids("OnboardingPlan").length
        ? db.onboardingPlan.findMany({
            where: { id: { in: ids("OnboardingPlan") } },
            select: { id: true, accountId: true, account: { select: { name: true } } },
          })
        : Promise.resolve([]),
      ids("OnboardingStep").length
        ? db.onboardingStep.findMany({
            where: { id: { in: ids("OnboardingStep") } },
            select: { id: true, title: true, plan: { select: { accountId: true } } },
          })
        : Promise.resolve([]),
      ids("FeatureCatalog").length
        ? db.featureCatalog.findMany({
            where: { id: { in: ids("FeatureCatalog") } },
            select: { id: true, label: true },
          })
        : Promise.resolve([]),
    ]);
  const plan = new Map(plans.map((p) => [p.id, p]));
  const step = new Map(steps.map((x) => [x.id, x]));
  const feature = new Map(features.map((f) => [f.id, f]));
  const signal = new Map(signals.map((s) => [s.id, s]));
  const reason = new Map(reasons.map((r) => [r.id, r]));
  const run = new Map(runs.map((r) => [r.id, r]));
  const account = new Map(accounts.map((a) => [a.id, a]));
  const draft = new Map(outbound.map((o) => [o.id, o]));
  const gone = (r: ProofRef): ProofLink => ({
    ...r,
    label: `${r.sourceType.replace(/([a-z])([A-Z])/g, "$1 $2")} (no longer on record)`,
    href: null,
    missing: true,
  });
  return refs.map((r): ProofLink => {
    switch (r.sourceType) {
      case "Signal": {
        const s = signal.get(r.sourceId);
        return s
          ? {
              ...r,
              label: `Signal: ${s.title}`,
              href: `/accounts/${s.accountId}/signals#signal-${s.id}`,
              missing: false,
            }
          : gone(r);
      }
      case "HealthReason": {
        const h = reason.get(r.sourceId);
        return h
          ? {
              ...r,
              label: `Health reason: ${h.message}`,
              href: `/accounts/${h.snapshot.accountId}/health?reason=${h.id}#reason-${h.id}`,
              missing: false,
            }
          : gone(r);
      }
      case "AgentRun": {
        const a = run.get(r.sourceId);
        return a
          ? {
              ...r,
              label: `Agent run (${a.agentKey})`,
              href: `/agent-runs/${a.id}`,
              missing: false,
            }
          : gone(r);
      }
      case "Account": {
        const a = account.get(r.sourceId);
        return a
          ? { ...r, label: `Account: ${a.name}`, href: `/accounts/${a.id}`, missing: false }
          : gone(r);
      }
      case "OutboundMessage": {
        const o = draft.get(r.sourceId);
        return o ? { ...r, label: `Draft: ${o.subject}`, href: null, missing: false } : gone(r);
      }
      case "OnboardingPlan": {
        const p = plan.get(r.sourceId);
        return p
          ? {
              ...r,
              label: `Onboarding plan: ${p.account.name}`,
              href: `/accounts/${p.accountId}/onboarding`,
              missing: false,
            }
          : gone(r);
      }
      case "OnboardingStep": {
        const x = step.get(r.sourceId);
        return x
          ? {
              ...r,
              label: `Onboarding step: ${x.title}`,
              href: `/accounts/${x.plan.accountId}/onboarding#step-${x.id}`,
              missing: false,
            }
          : gone(r);
      }
      case "FeatureCatalog": {
        const f = feature.get(r.sourceId);
        return f
          ? {
              ...r,
              label: `Feature in the plan: ${f.label}`,
              href: `/accounts/${accountId}/adoption`,
              missing: false,
            }
          : gone(r);
      }
      default: {
        if (!HEALTH_TYPES.has(r.sourceType))
          return { ...r, label: r.label ?? r.sourceType, href: null, missing: false };
        const d = describeSource(accountId, r, look);
        return { ...r, label: r.label ?? d.label, href: d.href, missing: d.missing };
      }
    }
  });
}
