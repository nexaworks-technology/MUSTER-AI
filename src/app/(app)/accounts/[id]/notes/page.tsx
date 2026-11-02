import type { Metadata } from "next";
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
    <div className="space-y-4">
      {account.canEdit ? (
        <NoteForm
          accountId={account.id}
          templates={templates.map((t) => ({ id: t.id, name: t.name, body: t.body }))}
        />
      ) : null}
      {notes.length === 0 ? (
        <p className="text-muted-foreground text-sm">No notes on this account yet.</p>
      ) : (
        <ul className="divide-border border-border divide-y rounded-md border text-sm">
          {notes.map((n) => (
            <li key={n.id} className="space-y-1 p-3" data-testid="note">
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
                      className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-xs"
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
