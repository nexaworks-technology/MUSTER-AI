import type { Metadata, Route } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listThreads } from "@/modules/ask-ai/service";

export const metadata: Metadata = { title: "Ask AI" };

/** Ask AI: your own conversations on the left (nobody else's), the open one on the right. */
export default async function AskLayout({ children }: { children: React.ReactNode }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const threads = await listThreads(ctx);
  return (
    <div className="gap-section flex flex-col md:flex-row md:items-start">
      <nav
        aria-label="Your conversations"
        className="surface space-y-3 p-4 text-sm md:w-64 md:shrink-0"
      >
        <Link href={"/ask" as Route} className="text-primary block font-medium hover:underline">
          New question
        </Link>
        {threads.length === 0 ? (
          <EmptyState className="px-3 py-2 text-xs">No conversations yet.</EmptyState>
        ) : (
          <ul className="border-border space-y-1 border-t pt-3" data-testid="thread-list">
            {threads.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/ask/${t.id}` as Route}
                  className="text-foreground hover:bg-hover line-clamp-2 block rounded-md px-2 py-1.5"
                >
                  {t.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="max-w-3xl min-w-0 flex-1 space-y-4">{children}</div>
    </div>
  );
}
