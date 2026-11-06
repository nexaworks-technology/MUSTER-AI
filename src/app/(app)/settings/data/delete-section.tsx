import type { WorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { DELETION_GRACE_DAYS, deletionStatus } from "@/modules/settings/service";
import { CancelDeletionForm, DeleteWorkspaceForm } from "./delete-form";

/** Admin-only workspace deletion with the Q-10 timeline stated plainly (M12 B2, D-179). */
export async function DeleteSection({ actor }: { actor: WorkspaceContext }) {
  const pending = await deletionStatus(actor);
  const tz = actor.workspace.timezone;
  return (
    <section aria-labelledby="delete" className="space-y-3 border-t pt-6">
      <h2 id="delete" className="text-base font-semibold">
        Delete this workspace
      </h2>
      <p className="text-muted-foreground text-sm">
        Deleting removes every account, contact, conversation, file, report and audit record of this
        workspace. You have {DELETION_GRACE_DAYS} days to change your mind; after that the data is
        purged, and backups that still hold it expire with our 35-day backup retention — so
        everything is gone within 30 days of the purge at the latest. Export first if you want a
        copy. A minimal record that this workspace existed and was deleted (its name tag and the
        dates) is kept.
      </p>
      {pending ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
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
