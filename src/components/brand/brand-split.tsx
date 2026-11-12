import type { ReactNode } from "react";
import { PRODUCT_NAME } from "@/config/product";
import { MusterMark } from "./muster-mark";

const LINES = [
  "Proactive signals on every account",
  "Approvals before anything is sent",
  "Answers that cite their sources",
];

/**
 * The split brand layout for sign-in and invitations. Left: the brand panel, a fixed look in
 * both app themes (warm charcoal, violet and terracotta aurora, the reversed mark, the wordmark,
 * the tagline and three quiet lines). On a phone it collapses to a compact band with the mark and
 * name. Right: the page's own content on warm paper.
 *
 * `wordmarkAs="h1"` makes the wordmark the page heading (sign-in); pages that have their own h1
 * (an invitation) keep the wordmark as text.
 */
export function BrandSplit({
  children,
  wordmarkAs = "p",
}: {
  children: ReactNode;
  wordmarkAs?: "h1" | "p";
}) {
  const Wordmark = wordmarkAs;
  return (
    <main className="flex min-h-screen flex-col md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section
        aria-label={PRODUCT_NAME}
        className="brand-panel flex items-center gap-3 px-5 py-4 md:flex-col md:items-start md:justify-center md:gap-0 md:px-14 md:py-16 lg:px-20"
      >
        <MusterMark variant="reversed" className="h-7 w-auto shrink-0 md:mb-10 md:h-24 lg:h-28" />
        <Wordmark className="font-display text-brand-warm-white text-lg font-medium tracking-[0.14em] uppercase md:text-5xl lg:text-6xl">
          {PRODUCT_NAME}
        </Wordmark>
        <div className="hidden md:block">
          <p className="text-brand-warm-white mt-5 text-xl">Your AI customer success manager.</p>
          <ul className="text-brand-panel-muted mt-10 space-y-3 text-sm">
            {LINES.map((line) => (
              <li key={line} className="flex items-center gap-3">
                <span aria-hidden="true" className="bg-brand-panel-muted size-1 rounded-full" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      </section>
      <section className="bg-ask-paper flex flex-1 items-center justify-center px-5 py-10 md:px-12 md:py-16">
        <div className="w-full max-w-sm">{children}</div>
      </section>
    </main>
  );
}
