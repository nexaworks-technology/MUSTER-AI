"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/** Uploads a signed contract document through /api/files (all checks are server-side). */
export function ContractDocumentUpload({
  accountId,
  contractId,
  accept,
}: {
  accountId: string;
  contractId: string;
  accept: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<{ ok?: string; error?: string; busy?: boolean }>({});
  async function submit(form: HTMLFormElement) {
    setState({ busy: true });
    const res = await fetch("/api/files", { method: "POST", body: new FormData(form) });
    const body = (await res.json().catch(() => ({}))) as { filename?: string; error?: string };
    if (res.ok) {
      setState({ ok: `Uploaded ${body.filename}.` });
      form.reset();
      router.refresh();
    } else {
      setState({ error: body.error ?? "The upload failed. Nothing was saved." });
    }
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
    >
      <input type="hidden" name="purpose" value="CONTRACT_DOCUMENT" />
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="contractId" value={contractId} />
      <div className="space-y-1">
        <Label htmlFor="contract-file">
          Signed contract (PDF, Word, image or text, up to 25 MB)
        </Label>
        <input
          id="contract-file"
          name="file"
          type="file"
          required
          accept={accept}
          className="block text-sm"
        />
      </div>
      <Button type="submit" variant="outline" disabled={state.busy}>
        {state.busy ? "Uploading…" : "Upload"}
      </Button>
      <p
        role={state.error ? "alert" : "status"}
        className={
          state.error ? "text-destructive w-full text-sm" : "text-muted-foreground w-full text-sm"
        }
      >
        {state.error ?? state.ok ?? ""}
      </p>
    </form>
  );
}
