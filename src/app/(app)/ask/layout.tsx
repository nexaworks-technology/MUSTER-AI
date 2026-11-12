import type { Metadata, Route } from "next";
import Link from "next/link";
import { MessageSquarePlus } from "lucide-react";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listThreads } from "@/modules/ask-ai/service";
import { ThreadLink } from "./thread-link";

export const metadata: Metadata = { title: "Ask AI" };

/**
 * Ask AI (Claude pattern): your own conversations on the left as a plain text list (nobody
 * else's), and one centred reading column for the open conversation on warm paper.
 */
export default async function AskLayout({ children }: { children: React.ReactNode }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const threads = await listThreads(ctx);
  return (
    <div className="bg-ask-paper border-ask-line flex min-h-[calc(100dvh-8rem)] flex-col rounded-2xl border md:flex-row">
      <nav
        aria-label="Your conversations"
        className="border-ask-line space-y-4 border-b px-3 py-4 md:w-64 md:shrink-0 md:border-r md:border-b-0"
      >
        <Link
          href={"/ask" as Route}
          className="text-foreground hover:bg-ask-wash focus-visible:ring-ring flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <MessageSquarePlus className="text-ask-accent size-4" aria-hidden="true" />
          <span>New question</span>
        </Link>
        <div>
          <p className="text-muted-foreground px-3 pb-1 text-xs font-medium">Recent threads</p>
          {threads.length === 0 ? (
            <p className="text-muted-foreground px-3 py-2 text-sm">No conversations yet.</p>
          ) : (
            <ul className="space-y-0.5" data-testid="thread-list">
              {threads.map((t) => (
                <li key={t.id}>
                  <ThreadLink id={t.id} title={t.title} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-6 px-5 py-8 md:px-8">
          {children}
        </div>
      </div>
    </div>
  );
}
