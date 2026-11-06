/**
 * Q-19 (Rule 8): what the AI provider does with this workspace's data, stated only as far as it is
 * verified. Source: docs/SECURITY.md "AI data use" (Anthropic's public terms, read 2026-11-06). The
 * account's own terms (zero-data-retention, signed DPA) are not yet confirmed and are said so.
 */
export function AiTermsSection() {
  return (
    <section aria-labelledby="ai-terms" className="surface space-y-3 p-5">
      <h2 id="ai-terms" className="text-base font-semibold">
        AI processing
      </h2>
      <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
        <li>
          To answer a question or draft for this workspace, the AI provider (Anthropic) receives
          only the records needed for that one request. Nothing from another workspace is ever
          included.
        </li>
        <li>
          Anthropic&apos;s public commercial terms (read 6 Nov 2026) say it may not train models on
          customer content, and that API inputs and outputs are deleted within 30 days by default.
        </li>
        <li>
          Our own account&apos;s terms with Anthropic (a zero-data-retention agreement, the signed
          data processing addendum) are not yet confirmed here.
        </li>
        <li>
          Health scores, risk, forecasts and money are calculated by our code, never by the AI.
        </li>
      </ul>
    </section>
  );
}
