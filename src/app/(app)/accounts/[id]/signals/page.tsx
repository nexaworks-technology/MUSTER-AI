import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/app/empty-state";
import { SignalList } from "@/components/app/signal-list";
import { OutsideSignalForm } from "@/components/app/outside-signal-form";
import { can } from "@/lib/auth/permissions";
import { todayIn } from "@/lib/dates";
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
        <EmptyState>
          No signals for this account. Signals are checked every night and when payments, tickets or
          a CSM Pulse change.
        </EmptyState>
      ) : (
        <SignalList
          signals={data.signals}
          rules={data.rules}
          canAct={() => canAct}
          today={todayIn(ctx.workspace.timezone)}
        />
      )}
      {account.canEdit ? (
        <details className="surface p-4">
          <summary className="cursor-pointer text-sm font-medium">Add an outside signal</summary>
          <div className="mt-2">
            <OutsideSignalForm accounts={[{ id: account.id, name: account.name }]} />
          </div>
        </details>
      ) : null}
    </section>
  );
}
