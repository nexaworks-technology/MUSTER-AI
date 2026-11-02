import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { applyAction, dismissAction, scanAction } from "@/modules/accounts/actions/data-quality";
import { listDataQualityIssues, previewDataQualityFixes } from "@/modules/accounts/service";
import { requireSettingsAccess } from "../access";

export const metadata: Metadata = { title: "Data quality" };

const KIND = {
  DUPLICATE_ACCOUNT: "Duplicate account",
  DUPLICATE_CONTACT: "Duplicate contact",
  INVALID_EMAIL: "Email",
  STALE: "Not updated",
} as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Settings › Data quality (spec §6A6). Fixes are two steps: choose issues → see every change
 * they will make → Confirm. The Confirm form carries exactly the previewed ids and versions.
 */
export default async function DataQualityPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requireSettingsAccess("data:import");
  const params = await searchParams;
  const issues = await listDataQualityIssues(ctx);
  const fixable = issues.filter((i) => i.fix.type !== "NONE");
  const requested = params.preview
    ? [params.preview].flat().flatMap((v) => (v === "all" ? fixable.map((i) => i.id) : [v]))
    : [];
  const preview = requested.length ? await previewDataQualityFixes(ctx, requested) : null;
  const fixed = one(params.fixed);
  const skipped = Number(one(params.skipped) ?? 0);
  const scanned = one(params.scanned);

  return (
    <div className="max-w-4xl space-y-6">
      <section aria-labelledby="dq" className="space-y-3">
        <h2 id="dq" className="text-base font-semibold">
          Data quality
        </h2>
        <p className="text-muted-foreground text-sm">
          Duplicates, messy emails and records nobody has touched in a while. Nothing is changed
          until you preview a fix and confirm it. Duplicate accounts and anything unclear are left
          for you to sort out by hand.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <form action={scanAction}>
            <Button type="submit" variant="outline">
              Run scan
            </Button>
          </form>
          {fixable.length > 0 && !preview ? (
            <Link href="/settings/data-quality?preview=all" className="text-sm underline">
              Preview all {fixable.length} safe fixes
            </Link>
          ) : null}
        </div>
        <div role="status" className="text-sm">
          {scanned !== undefined ? <p>Scan finished: {scanned} issues found.</p> : null}
          {fixed !== undefined ? (
            <p>
              {fixed} fixed.
              {skipped > 0
                ? ` ${skipped} skipped because they changed since the preview. Preview them again.`
                : ""}
            </p>
          ) : null}
        </div>
      </section>

      {preview ? (
        <section aria-labelledby="review" className="border-border space-y-3 rounded-md border p-4">
          <h2 id="review" className="text-base font-semibold">
            Review {preview.items.length} {preview.items.length === 1 ? "fix" : "fixes"}
          </h2>
          {preview.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing here can be fixed automatically.
            </p>
          ) : (
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              {preview.items.map((item) => (
                <li key={item.id}>
                  <p className="font-medium">{item.detail}</p>
                  <ul className="text-muted-foreground list-disc pl-5">
                    {item.changes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
          {preview.notFixable.length > 0 ? (
            <div className="text-muted-foreground space-y-1 text-sm">
              <p>Left out ({preview.notFixable.length}):</p>
              <ul className="list-disc pl-5">
                {[...new Set(preview.notFixable.map((n) => n.reason))].map((reason) => (
                  <li key={reason}>
                    {preview.notFixable.filter((n) => n.reason === reason).length} × {reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {preview.items.length > 0 ? (
              <form action={applyAction}>
                <input type="hidden" name="confirm" value="true" />
                <input
                  type="hidden"
                  name="items"
                  value={JSON.stringify(
                    preview.items.map((i) => ({ id: i.id, version: i.version })),
                  )}
                />
                <Button type="submit">
                  {preview.items.length === 1
                    ? "Confirm fix"
                    : `Confirm all ${preview.items.length} fixes`}
                </Button>
              </form>
            ) : null}
            <Link href="/settings/data-quality" className="text-sm underline">
              Cancel
            </Link>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="open" className="space-y-2">
        <h2 id="open" className="text-base font-semibold">
          Open issues ({issues.length})
        </h2>
        {issues.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No open issues. Run a scan after an import to check again.
          </p>
        ) : (
          <form action="/settings/data-quality" method="get" className="space-y-3">
            <ul className="divide-border border-border divide-y rounded-md border text-sm">
              {issues.map((i) => (
                <li key={i.id} className="flex flex-wrap items-start gap-3 p-3">
                  {i.fix.type !== "NONE" ? (
                    <input
                      type="checkbox"
                      name="preview"
                      value={i.id}
                      id={`issue-${i.id}`}
                      className="mt-1 size-4"
                    />
                  ) : (
                    <span className="size-4" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <label htmlFor={`issue-${i.id}`} className="block">
                      <span className="font-medium">{KIND[i.kind]}</span>
                      {i.account ? (
                        <>
                          {" · "}
                          <Link href={`/accounts/${i.account.id}`} className="underline">
                            {i.account.name}
                          </Link>
                        </>
                      ) : null}
                    </label>
                    <p>{i.detail}</p>
                    <p className="text-muted-foreground text-xs">
                      {i.fix.type === "NONE" ? "Needs a person" : "Safe fix available"} · found{" "}
                      {formatDateTime(i.createdAt, ctx.workspace.timezone)}
                    </p>
                  </div>
                  <Button
                    type="submit"
                    variant="ghost"
                    size="sm"
                    formAction={dismissAction.bind(null, i.id)}
                    aria-label={`Dismiss: ${i.detail}`}
                  >
                    Dismiss
                  </Button>
                </li>
              ))}
            </ul>
            {fixable.length > 0 ? (
              <Button type="submit" variant="outline">
                Preview selected fixes
              </Button>
            ) : null}
          </form>
        )}
      </section>
    </div>
  );
}
