"use client";

import { useState } from "react";
import { ActionForm } from "@/components/app/action-form";
import { Button } from "@/components/ui/button";
import {
  duplicatePlayAction,
  killPlayAction,
  pausePlayAction,
  publishPlayAction,
  revertPlayVersionAction,
} from "@/modules/plays/actions";

export function PublishPlayControl({
  playId,
  canPublish,
  matchingAccountsCount,
}: {
  playId: string;
  canPublish: boolean;
  matchingAccountsCount?: number;
}) {
  const [retroactive, setRetroactive] = useState(false);

  if (!canPublish) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4 bg-muted/20">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`retro-${playId}`}
          checked={retroactive}
          onChange={(e) => setRetroactive(e.target.checked)}
          className="size-4 rounded border-gray-300"
        />
        <label htmlFor={`retro-${playId}`} className="text-sm cursor-pointer">
          Also start for matching accounts ({matchingAccountsCount ?? 0} currently match)
        </label>
      </div>
      <ActionForm action={publishPlayAction} className="inline-flex">
        {(pending) => (
          <>
            <input type="hidden" name="playId" value={playId} />
            <input type="hidden" name="retroactive" value={retroactive ? "true" : "false"} />
            <Button type="submit" disabled={pending} size="sm">
              {pending ? "Publishing…" : "Publish Play"}
            </Button>
          </>
        )}
      </ActionForm>
    </div>
  );
}

export function PausePlayButton({
  playId,
  canPublish,
}: {
  playId: string;
  canPublish: boolean;
}) {
  if (!canPublish) return null;

  return (
    <ActionForm action={pausePlayAction} className="inline-flex">
      {(pending) => (
        <>
          <input type="hidden" name="playId" value={playId} />
          <Button type="submit" variant="outline" size="sm" disabled={pending}>
            {pending ? "Pausing…" : "Pause Play"}
          </Button>
        </>
      )}
    </ActionForm>
  );
}

export function KillPlayButton({
  playId,
  canPublish,
}: {
  playId: string;
  canPublish: boolean;
}) {
  if (!canPublish) return null;

  return (
    <ActionForm action={killPlayAction} className="inline-flex">
      {(pending) => (
        <>
          <input type="hidden" name="playId" value={playId} />
          <Button
            type="submit"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={(e) => {
              if (!confirm("Are you sure you want to kill this play? All active runs will exit immediately.")) {
                e.preventDefault();
              }
            }}
          >
            {pending ? "Killing…" : "Kill Play"}
          </Button>
        </>
      )}
    </ActionForm>
  );
}

export function DuplicatePlayButton({
  playId,
  canDraft,
}: {
  playId: string;
  canDraft: boolean;
}) {
  if (!canDraft) return null;

  return (
    <ActionForm action={duplicatePlayAction} className="inline-flex">
      {(pending) => (
        <>
          <input type="hidden" name="playId" value={playId} />
          <Button type="submit" variant="secondary" size="sm" disabled={pending}>
            {pending ? "Duplicating…" : "Duplicate"}
          </Button>
        </>
      )}
    </ActionForm>
  );
}

export function RevertVersionButton({
  playId,
  version,
  canDraft,
}: {
  playId: string;
  version: number;
  canDraft: boolean;
}) {
  if (!canDraft) return null;

  return (
    <ActionForm action={revertPlayVersionAction} className="inline-flex">
      {(pending) => (
        <>
          <input type="hidden" name="playId" value={playId} />
          <input type="hidden" name="version" value={version} />
          <Button type="submit" variant="ghost" size="xs" disabled={pending}>
            {pending ? "Reverting…" : `Revert to v${version}`}
          </Button>
        </>
      )}
    </ActionForm>
  );
}
