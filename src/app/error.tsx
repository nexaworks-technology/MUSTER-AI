"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

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
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10 md:py-16">
      <Card className="w-full items-center gap-3 px-6 py-10 text-center md:px-10 md:py-12">
        <span
          className="bg-warning-soft text-warning-soft-foreground flex size-12 items-center justify-center rounded-full"
          aria-hidden="true"
        >
          <TriangleAlert className="size-5" />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          The page could not load. Try again; if it keeps happening, give your admin this reference:{" "}
          <code className="bg-muted text-foreground rounded-sm px-1.5 py-0.5 text-xs">
            {error.digest ?? "none"}
          </code>
          .
        </p>
        <Button type="button" variant="outline" onClick={reset} className="mt-2">
          Try again
        </Button>
      </Card>
    </main>
  );
}
