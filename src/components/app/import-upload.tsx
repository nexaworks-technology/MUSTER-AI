"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Step 1: choose the template and upload the CSV. Nothing is imported until confirmed. */
export function ImportUpload({ templates }: { templates: Array<{ kind: string; title: string }> }) {
  const router = useRouter();
  const [state, setState] = useState<{ error?: string; busy?: boolean }>({});
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setState({ busy: true });
        const res = await fetch("/api/imports", {
          method: "POST",
          body: new FormData(e.currentTarget),
        });
        const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
        if (res.ok && body.id) router.push(`/settings/import/${body.id}`);
        else setState({ error: body.error ?? "The upload failed. Nothing was imported." });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="import-kind">What are you importing?</Label>
        <NativeSelect id="import-kind" name="kind" defaultValue="ACCOUNTS">
          {templates.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.title}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor="import-file">CSV file (UTF-8, up to 25 MB)</Label>
        <Input
          id="import-file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          required
          className="h-auto w-auto py-1.5"
        />
      </div>
      <Button type="submit" disabled={state.busy}>
        {state.busy ? "Uploading…" : "Upload and map columns"}
      </Button>
      {state.error ? (
        <p role="alert" className="text-destructive w-full text-sm">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
