import type { Metadata } from "next";
import { CircleCheck, LinkIcon } from "lucide-react";
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
  const form = !gate.refused && view && !view.answered ? view : null;
  return (
    <main className="bg-background mx-auto flex min-h-screen max-w-2xl items-center px-4 py-10 md:py-16">
      <div className="surface-card rounded-2xl border border-border/80 w-full p-6 md:p-10 shadow-sm" data-testid="survey-page">
        {form ? (
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl text-foreground">Your feedback</h1>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <span
              className={
                !gate.refused && view
                  ? "bg-success-soft text-success-soft-foreground flex size-12 items-center justify-center rounded-xl border border-success-soft-foreground/20"
                  : "bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-xl border border-border/60"
              }
              aria-hidden="true"
            >
              {!gate.refused && view ? (
                <CircleCheck className="size-5" />
              ) : (
                <LinkIcon className="size-5" />
              )}
            </span>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Your feedback</h1>
          </div>
        )}
        {gate.refused ? (
          <p className="text-muted-foreground mt-2 text-center text-sm leading-relaxed">
            {TOO_MANY}
          </p>
        ) : !view ? (
          <p className="text-muted-foreground mt-2 text-center text-sm leading-relaxed">
            This survey link is invalid or has expired.
          </p>
        ) : view.answered ? (
          <p className="text-muted-foreground mt-2 text-center text-sm leading-relaxed">
            This survey has already been answered. Thank you.
          </p>
        ) : (
          <SurveyForm token={token} question={view.question} range={RANGE[view.type] ?? [0, 10]} />
        )}
      </div>
    </main>
  );
}
