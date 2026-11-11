import type { Metadata, Route } from "next";
import Link from "next/link";
import { MessageSquarePlus } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";
import { DataListCard } from "@/components/app/data-list";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listThreads } from "@/modules/ask-ai/service";

export const metadata: Metadata = { title: "Ask AI" };

/** Ask AI: your own conversations on the left (nobody else's), the open one on the right. */
export default async function AskLayout({ children }: { children: React.ReactNode }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const threads = await listThreads(ctx);
  return (
    <div className="glass-scope gap-section flex flex-col md:flex-row md:items-start">
      <nav
        aria-label="Your conversations"
        className="space-y-3 md:w-64 md:shrink-0"
      >
        <Link
          href={"/ask" as Route}
          className="inline-flex items-center justify-center gap-2 w-full rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors"
        >
          <MessageSquarePlus className="size-4" />
          <span>New question</span>
        </Link>
        <DataListCard className="p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-2 pb-2">
            Recent threads
          </p>
          {threads.length === 0 ? (
            <EmptyState className="px-3 py-2 text-xs">No conversations yet.</EmptyState>
          ) : (
            <ul className="space-y-1" data-testid="thread-list">
              {threads.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/ask/${t.id}` as Route}
                    className="text-foreground hover:bg-muted/60 line-clamp-2 block rounded-md px-2.5 py-2 text-xs transition-colors"
                  >
                    {t.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DataListCard>
      </nav>
      <div className="max-w-3xl min-w-0 flex-1 space-y-4">{children}</div>
    </div>
  );
}
