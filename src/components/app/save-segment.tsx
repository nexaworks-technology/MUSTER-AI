"use client";

import { ActionForm } from "@/components/app/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveSegmentFromListAction } from "@/modules/segments/actions/segments";

export function SaveSegment({ filters }: { filters: Record<string, string | undefined> }) {
  return (
    <ActionForm action={saveSegmentFromListAction} className="flex flex-wrap items-end gap-2">
      {(pending) => (
        <>
          {Object.entries(filters).map(([k, v]) =>
            v ? <input key={k} type="hidden" name={k} value={v} /> : null,
          )}
          <div className="space-y-1">
            <Label htmlFor="segment-name">Save these filters as a segment</Label>
            <Input
              id="segment-name"
              name="name"
              required
              maxLength={80}
              placeholder="e.g. Long-tail adopting"
              className="w-64"
            />
          </div>
          <Button type="submit" variant="outline" disabled={pending}>
            Save segment
          </Button>
        </>
      )}
    </ActionForm>
  );
}
