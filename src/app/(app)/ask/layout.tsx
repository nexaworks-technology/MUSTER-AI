import type { Metadata, Route } from "next";
import Link from "next/link";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listThreads } from "@/modules/ask-ai/service";

export const metadata: Metadata = { title: "Ask AI" };

/** Ask AI: your own conversations on the left (nobody else's), the open one on the right. */
export default async function AskLayout({ children }: { children: React.ReactNode }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const threads = await listThreads(ctx);
  return (
    <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <nav aria-label="Your conversations" className="space-y-2 text-sm">
        <Link href={"/ask" as Route} className="font-medium underline">
          New question
        </Link>
        {threads.length === 0 ? (
          <p className="text-muted-foreground">No conversations yet.</p>
        ) : (
          <ul className="space-y-1" data-testid="thread-list">
            {threads.map((t) => (
              <li key={t.id}>
                <Link href={`/ask/${t.id}` as Route} className="line-clamp-2 hover:underline">
                  {t.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="max-w-3xl space-y-4">{children}</div>
    </div>
  );
}
