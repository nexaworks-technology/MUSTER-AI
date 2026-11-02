import type { FormState } from "@/modules/settings/actions/shared";

/** Inline result of a form action, announced to screen readers. */
export function FormMessage({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {state.ok}
      </p>
    );
  }
  return null;
}
