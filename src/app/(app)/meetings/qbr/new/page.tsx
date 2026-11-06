import type { Metadata } from "next";
import { NativeSelect } from "@/components/app/native-select";
import { Input } from "@/components/ui/input";
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
    <div className="space-y-section max-w-4xl" data-testid="new-qbr-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Generate Executive Business Review (QBR)
        </h1>
        <p className="text-muted-foreground text-sm">
          Metrics are deterministic and locked from database records. Narrative blocks are generated
          via AI and edited in text only.
        </p>
      </div>

      <div className="surface space-y-4 p-5">
        <h2 className="text-base font-semibold">Review Configuration</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="account-select" className="mb-1 block text-sm font-medium">
              Account
            </label>
            <NativeSelect
              id="account-select"
              data-testid="qbr-account-select"
              className="w-full"
              defaultValue={accounts[0]?.id}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <label htmlFor="period-input" className="mb-1 block text-sm font-medium">
              Period (e.g. Q3 2026)
            </label>
            <Input id="period-input" data-testid="qbr-period-input" defaultValue="Q3 2026" />
          </div>
        </div>
      </div>

      <section aria-labelledby="locked-metrics-heading" className="space-y-3">
        <h2 id="locked-metrics-heading" className="text-base font-semibold">
          Locked Metrics (Read-only)
        </h2>
        <div
          className="surface text-muted-foreground p-4 text-sm"
          data-testid="locked-metrics-panel"
        >
          Pick an account and generate review to compute locked metrics from database records.
        </div>
      </section>

      <section aria-labelledby="narrative-heading" className="space-y-3">
        <h2 id="narrative-heading" className="text-base font-semibold">
          Narrative Editor
        </h2>
        <div className="surface text-muted-foreground p-4 text-sm" data-testid="narrative-blocks">
          Text edits only; digits outside date patterns will be rejected by placeholder validator.
        </div>
      </section>
    </div>
  );
}
