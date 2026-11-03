"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { draftCheckInAction, type CheckInActionState } from "@/modules/agents/actions/checkin";

/**
 * Draft check-in (M4 §2): ask the Outreach Agent for a draft, or write it yourself. Both create a
 * draft and an approval; nothing is sent. Inputs are controlled (D-70) so an error keeps the text.
 */
export function CheckInForm({
  sourceType,
  sourceId,
  nonce,
  contacts,
  aiConfigured,
}: {
  sourceType: "Signal" | "Ticket";
  sourceId: string;
  nonce: string;
  contacts: Array<{ id: string; label: string }>;
  aiConfigured: boolean;
}) {
  const [state, run, pending] = useActionState<CheckInActionState, FormData>(
    draftCheckInAction,
    {},
  );
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const ids = { contact: useId(), subject: useId(), body: useId() };
  if (contacts.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        No active contact on this account has an email address, so there is no one to write to.
      </p>
    );
  return (
    <form action={run} className="space-y-4">
      <input type="hidden" name="sourceType" value={sourceType} />
      <input type="hidden" name="sourceId" value={sourceId} />
      <input type="hidden" name="nonce" value={nonce} />
      <div className="space-y-1">
        <label htmlFor={ids.contact} className="text-sm font-medium">
          To
        </label>
        <select
          id={ids.contact}
          name="contactId"
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          className="border-input bg-background h-9 w-full max-w-md rounded-md border px-2 text-sm"
        >
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {aiConfigured ? (
        <div className="space-y-1">
          <Button type="submit" name="mode" value="ai" disabled={pending}>
            Ask AI to draft it
          </Button>
          <p className="text-muted-foreground text-xs">
            The draft cites the records it used and waits in Approvals for you.
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm" data-testid="ai-not-configured">
          AI is not configured, so you write this one yourself.
        </p>
      )}
      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Write it yourself</legend>
        <div className="space-y-1">
          <label htmlFor={ids.subject} className="text-sm">
            Subject
          </label>
          <Input
            id={ids.subject}
            name="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.body} className="text-sm">
            Message
          </label>
          <textarea
            id={ids.body}
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            maxLength={10_000}
            className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
        </div>
        <Button type="submit" name="mode" value="human" variant="outline" disabled={pending}>
          Save draft for approval
        </Button>
      </fieldset>
      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : state.info ? (
        <p role="status" className="text-sm">
          {state.info}
        </p>
      ) : null}
    </form>
  );
}
