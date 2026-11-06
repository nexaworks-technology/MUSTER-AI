"use client";

import { useActionState } from "react";
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
  if (state.ok) return <p className="mt-2 text-sm">Thank you — your answer was recorded.</p>;
  const scores = Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i);
  return (
    <form action={action} className="mt-4 space-y-4">
      <input type="hidden" name="token" value={token} />
      <fieldset>
        <legend className="text-sm font-medium">{question}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {scores.map((s) => (
            <label key={s} className="flex items-center gap-1 rounded border px-2 py-1 text-sm">
              <input type="radio" name="score" value={s} required /> {s}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">
        Anything you want to add? (optional)
        <textarea name="comment" maxLength={2000} className="mt-1 w-full rounded border p-2" />
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
      >
        Send
      </button>
    </form>
  );
}
