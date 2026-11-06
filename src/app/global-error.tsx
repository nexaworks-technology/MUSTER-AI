"use client";

import "./globals.css";
import { TriangleAlert } from "lucide-react";

/**
 * M12 B7: replaces the root layout when it fails. Next's default injects a nonce-less <style>,
 * refused by the production CSP; this one uses the app stylesheet only. Digest only, never the message.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10 md:py-16">
          <div className="bg-card text-card-foreground border-border flex w-full flex-col items-center gap-3 rounded-lg border px-6 py-10 text-center shadow-sm md:px-10 md:py-12">
            <span
              className="bg-warning-soft text-warning-soft-foreground flex size-12 items-center justify-center rounded-full"
              aria-hidden="true"
            >
              <TriangleAlert className="size-5" />
            </span>
            <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Reload the page; if it keeps happening, give your admin this reference:{" "}
              <code className="bg-muted text-foreground rounded-sm px-1.5 py-0.5 text-xs">
                {error.digest ?? "none"}
              </code>
              .
            </p>
          </div>
        </main>
      </body>
    </html>
  );
}
