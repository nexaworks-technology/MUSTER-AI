import type { WorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { DELETION_GRACE_DAYS, deletionStatus } from "@/modules/settings/service";
import { CancelDeletionForm, DeleteWorkspaceForm } from "./delete-form";

/** Admin-only workspace deletion with the Q-10 timeline stated plainly (M12 B2, D-179). */
export async function DeleteSection({ actor }: { actor: WorkspaceContext }) {
  const pending = await deletionStatus(actor);
  const tz = actor.workspace.timezone;
  return (
    <section
      aria-labelledby="delete"
      className="bg-card border-danger/30 space-y-3 rounded-lg border p-5 shadow-xs"
    >
      <h2 id="delete" className="text-base font-semibold">
        Delete this workspace
      </h2>
      <p className="text-muted-foreground text-sm">
        Deleting removes every account, contact, conversation, file, report and audit record of this
        workspace. You have {DELETION_GRACE_DAYS} days to change your mind; after that the
        workspace&apos;s data is purged, so it is deleted within 30 days of your request. Copies
        that still sit in our backups expire with the 35-day backup retention. Export first if you
        want a copy. A minimal record that this workspace existed and was deleted (its name tag and
        the dates) is kept.
      </p>
      {pending ? (
        <div className="border-warning/30 bg-warning-soft text-warning-soft-foreground space-y-2 rounded-md border p-3 text-sm">
          <p data-testid="deletion-pending">
            Deletion requested {formatDateTime(pending.requestedAt, tz)}. Everything will be purged
            after {formatDateTime(pending.purgeAfter, tz)} unless you cancel.
          </p>
          <CancelDeletionForm />
        </div>
      ) : (
        <DeleteWorkspaceForm workspaceName={actor.workspace.name} />
      )}
    </section>
  );
}
