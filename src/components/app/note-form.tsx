"use client";

import { useState } from "react";
import { ActionForm } from "@/components/app/action-form";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createNoteAction } from "@/modules/notes/actions/notes";

export function NoteForm({
  accountId,
  templates,
}: {
  accountId: string;
  templates: Array<{ id: string; name: string; body: string }>;
}) {
  const [body, setBody] = useState("");
  return (
    <ActionForm action={createNoteAction} className="space-y-3">
      {(pending) => (
        <>
          <input type="hidden" name="accountId" value={accountId} />
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="note-template">Template</Label>
              <NativeSelect
                id="note-template"
                name="templateId"
                defaultValue=""
                onChange={(e) =>
                  setBody(templates.find((t) => t.id === e.target.value)?.body ?? body)
                }
              >
                <option value="">No template</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="min-w-48 flex-1 space-y-1">
              <Label htmlFor="note-tags">Tags (comma-separated)</Label>
              <Input id="note-tags" name="tags" placeholder="onboarding, sso" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="note-body">Note</Label>
            <textarea
              id="note-body"
              name="body"
              required
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="border-input bg-background focus-visible:ring-ring/50 w-full rounded-md border p-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
              aria-describedby="note-help"
            />
            <p id="note-help" className="text-muted-foreground text-xs">
              Mention a teammate with @ and their full name, for example @Aisha Bello.
            </p>
          </div>
          <Button type="submit" disabled={pending} onClick={() => setTimeout(() => setBody(""), 0)}>
            Save note
          </Button>
        </>
      )}
    </ActionForm>
  );
}
