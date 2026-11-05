import type { Metadata } from "next";
import { scopedDb } from "@/lib/db/scoped";
import { listSurveys } from "@/modules/surveys/service";
import { requireSettingsAccess } from "../access";

export const metadata: Metadata = { title: "Surveys settings" };

export default async function SurveysSettingsPage() {
  const ctx = await requireSettingsAccess("healthModel:propose");
  const surveys = await listSurveys(ctx);
  const db = scopedDb(ctx);

  const responses = await db.surveyResponse.findMany({
    orderBy: { respondedAt: "desc" },
    include: {
      account: { select: { id: true, name: true } },
      contact: { select: { id: true, name: true, email: true } },
    },
    take: 20,
  });

  return (
    <div className="max-w-4xl space-y-6" data-testid="surveys-settings">
      <div>
        <h1 className="text-2xl font-semibold">Customer Surveys</h1>
        <p className="text-muted-foreground text-sm">
          Journey-moment triggers feed health scores with audited source attribution.
        </p>
      </div>

      <section aria-labelledby="active-surveys-heading" className="space-y-3">
        <h2 id="active-surveys-heading" className="text-lg font-semibold">
          Active Surveys ({surveys.length})
        </h2>
        {surveys.length === 0 ? (
          <p className="text-muted-foreground text-sm">No surveys configured.</p>
        ) : (
          <div className="space-y-3">
            {surveys.map((s) => (
              <div key={s.id} className="rounded-md border p-4 space-y-1" data-testid="survey-item">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{s.type} Survey</span>
                  <span className="text-xs uppercase px-2 py-0.5 rounded border">{s.status}</span>
                </div>
                <p className="text-sm">{s.question}</p>
                <p className="text-xs text-muted-foreground">Trigger: {s.trigger}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="responses-heading" className="space-y-3">
        <h2 id="responses-heading" className="text-lg font-semibold">
          Recent Responses ({responses.length})
        </h2>
        {responses.length === 0 ? (
          <p className="text-muted-foreground text-sm">No responses received yet.</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm" data-testid="responses-list">
            {responses.map((r) => (
              <li key={r.id} className="p-3 space-y-1" data-testid="response-row">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{r.account?.name ?? "Unknown account"}</span>
                  <span className="text-xs font-semibold">Score: {r.score}</span>
                </div>
                {r.comment ? (
                  <p className="text-xs text-muted-foreground italic">&ldquo;{r.comment}&rdquo;</p>
                ) : null}
                <div className="text-xs text-muted-foreground">
                  By {r.contact?.name ?? r.contact?.email ?? "Anonymous"} ·{" "}
                  {r.respondedAt ? new Date(r.respondedAt).toLocaleDateString() : "Just now"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
