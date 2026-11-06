"use client";

/**
 * M12 B7: the app's own error boundary (Next's default injects a nonce-less <style>, refused by the
 * production CSP). It shows the error digest only — never the message, which may hold record data.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-md space-y-3 p-8">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground text-sm">
        The page could not load. Try again; if it keeps happening, give your admin this reference:{" "}
        <code>{error.digest ?? "none"}</code>.
      </p>
      <button type="button" onClick={reset} className="text-sm underline">
        Try again
      </button>
    </main>
  );
}
