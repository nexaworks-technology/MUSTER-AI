/**
 * M11 close demo (founder decision, Session 2): the Outcome Ledger's full save chain, LIVE on
 * Harborwood Accounting, with the business clock moved forward through the checkpoints.
 *
 *   pnpm exec tsx --env-file=.env scripts/demo-m11-save-chain.ts --workspace <slug>
 *
 * DEMO-ONLY SEAM: every step passes an explicit demo clock to the real service (nothing is
 * hand-written: no signal, outcome, forecast or checkpoint value). Refused in production.
 *   1. [DEMO CLOCK 2026-11-21] the real signal rules run for Harborwood: its renewal on 2026-12-21
 *      is 30 days away → `renewal_window_30` (WARN, risk) opens with its OutcomeRecord (the flag).
 *   2. [DEMO CLOCK 2026-11-22] a CSM-written check-in goes through approvals: requested, approved
 *      by Dana, dispatched by the outbound guards (dev transport logs it) → the flag is ACTED.
 *   3. [DEMO CLOCK 2026-12-22] the successor contract is on file; the real renewal sync records
 *      the renewal as RENEWED (forecast frozen as it stood).
 *   4. [DEMO CLOCK 7 days after each checkpoint] the real checkpoint code stores day 7, day 30 and
 *      day 90 (frozen) → day 90 RENEWED + ACTED = a save, worth the ARR at the flag (Q-15).
 * Idempotent: a second run reports what is already recorded and changes nothing.
 */
import { addDays, calendarDateOf, localDate } from "@/lib/dates";
import { env } from "@/lib/config/env";
import { scopedDb } from "@/lib/db/scoped";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { approve, requestApproval } from "@/modules/approvals/service";
import {
  evaluateLongCheckpoints,
  evaluateRevenueCheckpoints,
  evaluateSevenDayCheckpoints,
  type LongCheckpoint,
} from "@/modules/outcomes/service";
import { syncRenewals } from "@/modules/renewals/service";
import { evaluateAndStore } from "@/modules/signals/service";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const at = (day: string, hour = 12) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
const say = (clock: string, text: string) => console.log(`[DEMO CLOCK ${clock}] ${text}`);

async function main() {
  if (env().NODE_ENV === "production") throw new Error("This demo script is refused in production");
  const slug = arg("workspace");
  if (!slug) throw new Error("usage: … --workspace <slug>");
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  const ctx = { workspaceId: ws.id };
  const db = scopedDb(ctx);
  const account = await db.account.findFirstOrThrow({ where: { name: "Harborwood Accounting" } });
  const dana = await db.membership.findFirstOrThrow({
    where: { user: { email: "dana@larkspur.test" } },
    include: { user: true },
  });
  const actor = {
    workspaceId: ws.id,
    userId: dana.userId,
    membershipId: dana.id,
    role: dana.role,
    canViewRevenue: dana.canViewRevenue,
    bookScope: dana.bookScope,
  };
  console.log(
    "=== M11 save chain — Harborwood Accounting (demo-only business clock; nothing hand-written) ===",
  );

  // 1. The flag, from the real rules on the real renewal date.
  const renewal = await db.renewal.findFirst({
    where: { accountId: account.id },
    orderBy: { renewalDate: "asc" },
    include: { contract: true },
  });
  if (!renewal) throw new Error("Harborwood has no renewal on file");
  const renewsOn = calendarDateOf(renewal.renewalDate);
  const flagDay = addDays(renewsOn, -30);
  const existingSignal = await db.signal.findFirst({
    where: { accountId: account.id, ruleKey: "renewal_window_30" },
  });
  if (!existingSignal) {
    const res = await evaluateAndStore(ctx, [account.id], flagDay, () => at(flagDay, 2));
    say(flagDay, `signal rules ran for Harborwood: ${JSON.stringify(res)}`);
  }
  const signal = await db.signal.findFirstOrThrow({
    where: { accountId: account.id, ruleKey: "renewal_window_30" },
  });
  const record = await db.outcomeRecord.findUniqueOrThrow({
    where: { workspaceId_signalId: { workspaceId: ws.id, signalId: signal.id } },
  });
  say(
    flagDay,
    `FLAG  signal ${signal.id} "${signal.title}" (${signal.severity}, ${signal.polarity}); outcome record ${record.id}, ARR at flag ${record.arrAtFlagMinor ?? "none"} minor ${record.arrCurrency ?? ""}`,
  );

  // 2. The action: a CSM-written check-in, approved and dispatched through the guards.
  const actDay = addDays(flagDay, 1);
  const contact = await db.contact.findFirstOrThrow({
    where: { accountId: account.id, email: { not: null } },
    orderBy: { name: "asc" },
  });
  const approval = await requestApproval(
    actor,
    {
      accountId: account.id,
      kind: "SEND_EMAIL",
      reason: "Renewal in 30 days: check in before the renewal date",
      proof: [{ sourceType: "Signal", sourceId: signal.id }],
      signalId: signal.id,
      proposedByMembershipId: dana.id,
      sourceKey: `demo-m11:save-chain:${signal.id}`,
      email: {
        contactId: contact.id,
        subject: "Your renewal next month",
        body: `Hi ${contact.name.split(" ")[0]},\n\nYour renewal is coming up next month. Is there anything you would like to review together before then?\n\nDana`,
        origin: "HUMAN",
      },
    },
    { clock: () => at(actDay, 9) },
  );
  if (approval.status === "PENDING") {
    const res = await approve(
      actor,
      { approvalId: approval.id },
      { clock: () => at(actDay, 10), dispatch: { clock: () => at(actDay, 10) } },
    );
    say(
      actDay,
      `ACTION approval ${approval.id} approved by Dana; send: ${JSON.stringify(res.send?.status ?? res.send)}`,
    );
  } else say(actDay, `ACTION approval ${approval.id} already ${approval.status}`);
  const message = await db.outboundMessage.findFirst({ where: { approvalId: approval.id } });
  say(actDay, `       outbound message ${message?.id ?? "none"} status ${message?.status ?? "-"}`);

  // 3. The renewal, from contract records through the real sync.
  const after = addDays(renewsOn, 1);
  const open = await db.renewal.findFirst({
    where: { id: renewal.id, stage: { in: ["UPCOMING", "IN_PROGRESS"] } },
  });
  if (open) {
    const old = renewal.contract;
    const successor = await db.contract.findFirst({
      where: { accountId: account.id, startDate: renewal.renewalDate, id: { not: old.id } },
    });
    if (!successor)
      await db.contract.create({
        data: {
          workspaceId: ws.id,
          accountId: account.id,
          startDate: renewal.renewalDate,
          endDate: at(addDays(renewsOn, 365), 0),
          renewalDate: at(addDays(renewsOn, 365), 0),
          noticePeriodDays: old.noticePeriodDays,
          valueMinor: old.valueMinor,
          currency: old.currency,
          seatsPurchased: old.seatsPurchased,
          status: "ACTIVE",
          source: "MANUAL",
        },
      });
    await db.contract.update({
      where: { id: old.id },
      data: { endDate: renewal.renewalDate, status: "ENDED" },
    });
    await syncRenewals(ctx, [account.id], after);
  }
  const outcome = await db.renewalOutcome.findFirstOrThrow({ where: { renewalId: renewal.id } });
  say(
    after,
    `WIN   renewal ${renewal.id} recorded ${outcome.result} on ${calendarDateOf(outcome.occurredOn)} from contract records (forecast frozen at ${outcome.forecastConfidence}% ${outcome.forecastBand}); RenewalOutcome ${outcome.id}`,
  );

  // 4. The checkpoints, by the real code, a grace week after each checkpoint date.
  const flaggedOn = localDate(record.flaggedAt, ws.timezone);
  for (const [label, day] of [
    ["day 7", addDays(flaggedOn, 7 + 1)],
    ["day 30", addDays(flaggedOn, 30 + 7)],
    ["day 90", addDays(flaggedOn, 90 + 7)],
  ] as const) {
    const clock = () => at(day);
    await evaluateSevenDayCheckpoints(ctx, clock);
    await evaluateRevenueCheckpoints(ctx, clock);
    await evaluateLongCheckpoints({ ...ctx, timezone: ws.timezone }, clock);
    say(day, `checkpoint pass for ${label} done`);
  }
  const final = await db.outcomeRecord.findUniqueOrThrow({ where: { id: record.id } });
  const d90 = final.d90Outcome as unknown as LongCheckpoint | null;
  console.log("--- result (stored, frozen) ---");
  console.log(
    `actionTaken=${final.actionTaken} firstActionAt=${final.firstActionAt?.toISOString() ?? "-"}`,
  );
  console.log(
    `d7=${(final.d7Outcome as { status?: string } | null)?.status ?? "-"} d30=${(final.d30Outcome as { status?: string } | null)?.status ?? "-"} d90=${d90?.status ?? "-"} (due ${d90?.dueOn ?? "-"}, acted at checkpoint: ${d90?.actionTaken ?? "-"})`,
  );
  console.log(`d90 evidence: ${JSON.stringify(d90?.evidence ?? [])}`);
  console.log(
    `saved per the ledger (Q-15): ${d90?.actionTaken === "ACTED" && (d90.status === "RENEWED" || d90.status === "RECOVERED") ? `yes — ARR at flag ${final.arrAtFlagMinor} minor ${final.arrCurrency}` : "no"}`,
  );
  console.log(`M7 valueSavedMinor (renewals only): ${final.valueSavedMinor ?? "none"}`);
  console.log(`save record: /reports/outcomes/${final.id}`);
  console.log(
    `To see it in the ledger, run the app with ALLOW_FAKE_CLOCK=true APP_FAKE_NOW=${addDays(flaggedOn, 97)}T12:00:00Z (demo-only seam, non-production).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
