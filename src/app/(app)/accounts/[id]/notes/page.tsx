import type { Metadata } from "next";
import { EmptyState } from "@/components/app/empty-state";
import { NoteForm } from "@/components/app/note-form";
import { formatDateTime } from "@/lib/format";
import { listNotes, listNoteTemplates } from "@/modules/notes/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Notes" };

export default async function NotesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const [notes, templates] = await Promise.all([
    listNotes(ctx, account.id),
    listNoteTemplates(ctx),
  ]);
  return (
    <div className="space-y-section">
      {account.canEdit ? (
        <div className="surface p-5">
          <NoteForm
            accountId={account.id}
            templates={templates.map((t) => ({ id: t.id, name: t.name, body: t.body }))}
          />
        </div>
      ) : null}
      {notes.length === 0 ? (
        <EmptyState>No notes on this account yet.</EmptyState>
      ) : (
        <ul className="surface divide-border divide-y overflow-hidden text-sm">
          {notes.map((n) => (
            <li key={n.id} className="space-y-1.5 p-4" data-testid="note">
              <div className="text-muted-foreground text-xs">
                {n.author?.user.name ?? n.author?.user.email ?? "Former member"} ·{" "}
                {formatDateTime(n.createdAt, ctx.workspace.timezone)}
                {n.template ? ` · ${n.template.name}` : ""}
              </div>
              <p className="whitespace-pre-wrap">{n.body}</p>
              {n.tags.length > 0 ? (
                <ul className="flex flex-wrap gap-1" aria-label="Tags">
                  {n.tags.map((t) => (
                    <li
                      key={t}
                      className="bg-secondary text-secondary-foreground rounded-full px-2.5 py-0.5 text-xs font-medium"
                    >
                      {t}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
