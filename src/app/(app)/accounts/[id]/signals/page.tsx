import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SignalList } from "@/components/app/signal-list";
import { can } from "@/lib/auth/permissions";
import { listAccountSignals } from "@/modules/signals/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Signals" };

/** Account 360 › Signals: live first, then history; every signal shows its evidence and rule. */
export default async function AccountSignalsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const data = await listAccountSignals(ctx, account.id);
  if (!data) notFound();
  const canAct = account.canEdit && can(ctx, "signals:markFalseAlarm") !== null;
  return (
    <section aria-labelledby="signals" className="space-y-3">
      <h2 id="signals" className="text-base font-semibold">
        Signals
      </h2>
      {data.signals.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No signals for this account. Signals are checked every night and when payments, tickets or
          a CSM Pulse change.
        </p>
      ) : (
        <SignalList signals={data.signals} rules={data.rules} canAct={() => canAct} />
      )}
    </section>
  );
}
