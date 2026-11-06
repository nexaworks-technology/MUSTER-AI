import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { scopedDb } from "@/lib/db/scoped";
import { QbrForm } from "./qbr-form";

export const metadata: Metadata = { title: "New QBR" };

/**
 * Generate a QBR (M12 Session C, C0a): pick an account and a period. The existing `generateQbr`
 * computes the locked metrics from the account's records, writes the narrative through the
 * audited Meeting & QBR agent, stores the QBR, and the member lands on it.
 */
export default async function NewQbrPage() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) notFound();
  const accounts = await scopedDb(ctx).account.findMany({
    where: { lifecycleStage: { not: "LOST" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="space-y-section max-w-4xl" data-testid="new-qbr-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Generate Executive Business Review (QBR)
        </h1>
        <p className="text-muted-foreground text-sm">
          Metrics are computed from the account&apos;s records and locked. The narrative is written
          by the Meeting &amp; QBR agent from those same records.
        </p>
      </div>
      {accounts.length === 0 ? (
        <p className="text-muted-foreground text-sm">No active accounts to review yet.</p>
      ) : null}
      <QbrForm accounts={accounts} />
    </div>
  );
}
