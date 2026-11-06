import type { Metadata } from "next";
import { noteAuthFailure, openTokenPage, TOO_MANY } from "@/lib/http/action-guard";
import { LIMITS } from "@/lib/http/guard";
import { getSurveyForToken } from "@/modules/surveys/service";
import { SurveyForm } from "./survey-form";

export const metadata: Metadata = { title: "Survey" };

const RANGE: Record<string, [number, number]> = { NPS: [0, 10], CSAT: [1, 5], CES: [1, 7] };

/** Public survey page (M12 A10): the token alone opens it; nothing else of the account is shown. */
export default async function SurveyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const gate = await openTokenPage("survey", LIMITS.surveyPerIp);
  const view = gate.refused ? null : await getSurveyForToken(token);
  if (!gate.refused && !view) await noteAuthFailure(gate.ip);
  return (
    <main className="mx-auto max-w-xl p-8">
      <div className="rounded-md border p-6" data-testid="survey-page">
        <h1 className="text-xl font-semibold">Your feedback</h1>
        {gate.refused ? (
          <p className="text-muted-foreground mt-2 text-sm">{TOO_MANY}</p>
        ) : !view ? (
          <p className="text-muted-foreground mt-2 text-sm">
            This survey link is invalid or has expired.
          </p>
        ) : view.answered ? (
          <p className="text-muted-foreground mt-2 text-sm">
            This survey has already been answered. Thank you.
          </p>
        ) : (
          <SurveyForm token={token} question={view.question} range={RANGE[view.type] ?? [0, 10]} />
        )}
      </div>
    </main>
  );
}
