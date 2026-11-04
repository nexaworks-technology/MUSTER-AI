/**
 * `pnpm exec tsx --env-file=.env scripts/demo-renewal-outcome.ts --workspace <slug> [--account "<name>"] [--as-of YYYY-MM-DD]`
 *
 * DEV / DEMO ONLY (refused in production). Shows an outcome recorded with its frozen forecast through
 * the real code path: it adds the successor contract record a renewal would produce (a new contract
 * starting on the old one's renewal date), then runs `renewals.sync` and the revenue outcome
 * checkpoint for that one account as of the day after the renewal. The sync detects RENEWED from the
 * contract records and stores the append-only RenewalOutcome carrying the forecast as it stood
 * before. Defaults: Harborwood Accounting, as of the day after its renewal. Safe to re-run: an account with a
 * recorded outcome is left as it is.
 */
import { env } from "@/lib/config/env";
import { addDays, calendarDateOf } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { evaluateRevenueCheckpoints } from "@/modules/outcomes/service";
import { syncRenewals } from "@/modules/renewals/service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (env().NODE_ENV === "production") throw new Error("This demo script is refused in production");
  const slug = arg("workspace");
  if (!slug)
    throw new Error('usage: … --workspace <slug> [--account "<name>"] [--as-of YYYY-MM-DD]');
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  const ctx = { workspaceId: ws.id };
  const db = scopedDb(ctx);
  const name = arg("account") ?? "Harborwood Accounting";
  const account = await db.account.findFirstOrThrow({ where: { name } });
  if ((await db.renewalOutcome.count({ where: { accountId: account.id } })) > 0) {
    console.log(`${name}: an outcome is already recorded for this account; nothing changed.`);
    return;
  }
  const renewal = await db.renewal.findFirst({
    where: { accountId: account.id, stage: { in: ["UPCOMING", "IN_PROGRESS"] } },
    orderBy: { renewalDate: "asc" },
    include: { contract: true },
  });
  if (!renewal) {
    console.log(`${name}: no open renewal (its outcome is already recorded); nothing changed.`);
    return;
  }
  const renewsOn = calendarDateOf(renewal.renewalDate);
  const asOf = arg("as-of") ?? addDays(renewsOn, 1);
  const old = renewal.contract;
  const successorExists = await db.contract.findFirst({
    where: { accountId: account.id, startDate: renewal.renewalDate, id: { not: old.id } },
  });
  if (!successorExists)
    await db.contract.create({
      data: {
        workspaceId: ws.id,
        accountId: account.id,
        startDate: renewal.renewalDate,
        endDate: new Date(`${addDays(renewsOn, 365)}T00:00:00Z`),
        renewalDate: new Date(`${addDays(renewsOn, 365)}T00:00:00Z`),
        noticePeriodDays: old.noticePeriodDays,
        valueMinor: old.valueMinor,
        currency: old.currency,
        seatsPurchased: old.seatsPurchased,
        status: "ACTIVE",
        source: "MANUAL",
      },
    });
  // The old contract ends on its renewal date; the new one carries the account forward.
  await db.contract.update({
    where: { id: old.id },
    data: { endDate: renewal.renewalDate, status: "ENDED" },
  });
  const counts = await syncRenewals(ctx, [account.id], asOf);
  const revenue = await evaluateRevenueCheckpoints(ctx, () => new Date(`${asOf}T12:00:00Z`));
  const outcome = await db.renewalOutcome.findFirstOrThrow({ where: { renewalId: renewal.id } });
  console.log(
    `${name}: renewal on ${renewsOn} recorded as ${outcome.result} on ${calendarDateOf(outcome.occurredOn)} from contract records; ` +
      `forecast frozen at ${outcome.forecastConfidence}% (${outcome.forecastBand}) as of ${calendarDateOf(outcome.forecastAsOf)}. ` +
      `Sync: ${JSON.stringify(counts)}; revenue checkpoints changed: ${revenue.changed}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
