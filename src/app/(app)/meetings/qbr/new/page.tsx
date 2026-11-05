import type { Metadata } from "next";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { scopedDb } from "@/lib/db/scoped";

export const metadata: Metadata = { title: "New QBR" };

export default async function NewQbrPage() {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const db = scopedDb(ctx);
  const accounts = await db.account.findMany({
    where: { lifecycleStage: { not: "LOST" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="max-w-4xl space-y-6" data-testid="new-qbr-page">
      <div>
        <h1 className="text-2xl font-semibold">Generate Executive Business Review (QBR)</h1>
        <p className="text-muted-foreground text-sm">
          Metrics are deterministic and locked from database records. Narrative blocks are generated via AI and edited in text only.
        </p>
      </div>

      <div className="rounded-md border p-4 space-y-4">
        <h2 className="text-base font-semibold">Review Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="account-select" className="block text-sm font-medium mb-1">
              Account
            </label>
            <select
              id="account-select"
              data-testid="qbr-account-select"
              className="w-full rounded-md border p-2 text-sm bg-background"
              defaultValue={accounts[0]?.id}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="period-input" className="block text-sm font-medium mb-1">
              Period (e.g. Q3 2026)
            </label>
            <input
              id="period-input"
              data-testid="qbr-period-input"
              className="w-full rounded-md border p-2 text-sm bg-background"
              defaultValue="Q3 2026"
            />
          </div>
        </div>
      </div>

      <section aria-labelledby="locked-metrics-heading" className="space-y-2">
        <h2 id="locked-metrics-heading" className="text-base font-semibold">
          Locked Metrics (Read-only)
        </h2>
        <div className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="locked-metrics-panel">
          Pick an account and generate review to compute locked metrics from database records.
        </div>
      </section>

      <section aria-labelledby="narrative-heading" className="space-y-2">
        <h2 id="narrative-heading" className="text-base font-semibold">
          Narrative Editor
        </h2>
        <div className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="narrative-blocks">
          Text edits only; digits outside date patterns will be rejected by placeholder validator.
        </div>
      </section>
    </div>
  );
}
