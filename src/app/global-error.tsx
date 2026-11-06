"use client";

import "./globals.css";

/**
 * M12 B7: replaces the root layout when it fails. Next's default injects a nonce-less <style>,
 * refused by the production CSP; this one uses the app stylesheet only. Digest only, never the message.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <main className="mx-auto max-w-md space-y-3 p-8">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-muted-foreground text-sm">
            Reload the page; if it keeps happening, give your admin this reference:{" "}
            <code>{error.digest ?? "none"}</code>.
          </p>
        </main>
      </body>
    </html>
  );
}
