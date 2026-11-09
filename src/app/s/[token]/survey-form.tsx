"use client";

import { useActionState } from "react";
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { submitSurveyFormAction, type SurveyFormState } from "./actions";

export function SurveyForm({
  token,
  question,
  range,
}: {
  token: string;
  question: string;
  range: [number, number];
}) {
  const [state, action, pending] = useActionState<SurveyFormState, FormData>(
    submitSurveyFormAction,
    {},
  );
  if (state.ok)
    return (
      <div className="mt-4 flex flex-col items-center gap-3 text-center">
        <span
          className="bg-success-soft text-success-soft-foreground flex size-12 items-center justify-center rounded-full"
          aria-hidden="true"
        >
          <CircleCheck className="size-5" />
        </span>
        <p className="text-sm leading-relaxed">Thank you — your answer was recorded.</p>
      </div>
    );
  const scores = Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i);
  return (
    <form action={action} className="mt-6 space-y-6">
      <input type="hidden" name="token" value={token} />
      <fieldset>
        <legend className="text-base leading-snug font-medium">{question}</legend>
        <div className="mt-4 flex flex-wrap gap-2">
          {scores.map((s) => (
            <label key={s} className="cursor-pointer">
              <input type="radio" name="score" value={s} required className="peer sr-only" />
              <span className="border-border/80 bg-background text-foreground hover:bg-muted/60 peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-ring peer-focus-visible:ring-offset-background flex size-11 items-center justify-center rounded-xl border text-sm font-semibold tabular-nums shadow-xs transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2">
                {s}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block space-y-2 text-sm font-medium text-foreground">
        Anything you want to add? (optional)
        <Textarea name="comment" maxLength={2000} className="min-h-28 font-normal rounded-xl border-border/80 bg-background/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs text-sm" />
      </label>
      {state.error ? (
        <p role="alert" className="text-danger text-sm">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto shadow-xs font-medium">
        Send
      </Button>
    </form>
  );
}
