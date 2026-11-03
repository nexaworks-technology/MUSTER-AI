import type { DataQualityIssue, DataQualityStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { getSettingsData } from "@/modules/settings/service";
import { detectIssues, dqFix, type DqFix } from "./data-quality";
import type { Actor } from "./service";

/**
 * Data-quality checker (spec §6A6, D-49). A scan records issues; a person previews the exact
 * changes and confirms. Nothing is merged or rewritten without `confirm: true`, and a bulk
 * apply touches exactly the previewed issues at the previewed version.
 */

type Tx = Prisma.TransactionClient;

export async function runDataQualityScan(actor: Actor, now = new Date()) {
  requirePermission(actor, "data:import");
  const db = scopedDb(actor);
  const [settings, accounts, contacts, existing] = await Promise.all([
    getSettingsData(actor.workspaceId),
    db.account.findMany({
      select: {
        id: true,
        name: true,
        domain: true,
        lifecycleStage: true,
        createdAt: true,
        updatedAt: true,
        lastTouchAt: true,
      },
    }),
    db.contact.findMany({
      select: { id: true, accountId: true, name: true, email: true, createdAt: true },
    }),
    // CONFLICT issues come from syncs (Q-32), not from this scan, so the scan never resolves them.
    db.dataQualityIssue.findMany({ where: { kind: { not: "CONFLICT" } } }),
  ]);
  const detected = detectIssues({
    accounts,
    contacts,
    now,
    staleAfterDays: settings.dataQuality.staleAfterDays,
  });
  const byKey = new Map(existing.map((i) => [i.dedupeKey, i]));
  const seen = new Set<string>();
  let created = 0;
  let resolved = 0;
  await db.$tenantTransaction(async (tx) => {
    for (const d of detected) {
      seen.add(d.dedupeKey);
      const fields = {
        kind: d.kind,
        accountId: d.accountId,
        contactId: d.contactId,
        detail: d.detail,
        suggestedFix: d.fix,
      };
      const prev = byKey.get(d.dedupeKey);
      if (!prev) {
        await tx.dataQualityIssue.create({
          data: { workspaceId: actor.workspaceId, dedupeKey: d.dedupeKey, ...fields },
        });
        created++;
        continue;
      }
      // Dismissed stays dismissed; a fixed or resolved problem that is back reopens. Only a
      // real change bumps the version a preview pinned.
      if (prev.status === "DISMISSED") continue;
      const same =
        prev.status === "OPEN" &&
        prev.detail === d.detail &&
        JSON.stringify(prev.suggestedFix) === JSON.stringify(d.fix);
      if (!same) {
        await tx.dataQualityIssue.update({
          where: { id: prev.id },
          data: { ...fields, status: "OPEN" },
        });
      }
    }
    const gone = existing.filter((i) => i.status === "OPEN" && !seen.has(i.dedupeKey));
    if (gone.length) {
      await tx.dataQualityIssue.updateMany({
        where: { id: { in: gone.map((i) => i.id) } },
        data: { status: "RESOLVED" },
      });
      resolved = gone.length;
    }
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "data_quality.scanned",
        targetType: "Workspace",
        targetId: actor.workspaceId,
        summary: `Data-quality scan: ${detected.length} found, ${created} new, ${resolved} resolved`,
      },
      tx,
    );
  });
  return { found: detected.length, created, resolved };
}

export async function listDataQualityIssues(
  actor: Actor,
  status: DataQualityStatus | "ALL" = "OPEN",
) {
  requirePermission(actor, "data:import");
  const issues = await scopedDb(actor).dataQualityIssue.findMany({
    where: status === "ALL" ? {} : { status },
    include: { account: { select: { id: true, name: true } } },
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return issues.map((i) => ({ ...i, fix: dqFix.parse(i.suggestedFix) }));
}

export async function dismissDataQualityIssue(actor: Actor, issueId: string) {
  requirePermission(actor, "data:import");
  const db = scopedDb(actor);
  await db.$tenantTransaction(async (tx) => {
    const issue = await tx.dataQualityIssue.findUnique({ where: { id: issueId } });
    if (!issue || issue.status !== "OPEN") return;
    await tx.dataQualityIssue.update({
      where: { id: issueId },
      data: { status: "DISMISSED", fixedByMembershipId: actor.membershipId, fixedAt: new Date() },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "data_quality.dismissed",
        targetType: "DataQualityIssue",
        targetId: issueId,
        summary: `Dismissed: ${issue.detail}`,
      },
      tx,
    );
  });
}

// ─── Preview & apply ────────────────────────────────────────────────────────

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const quoted = (s: string | null) => (s === null ? "no email" : `"${s}"`);

/** Checks the fix still matches the data and lists, in words, every change it would make. */
async function describeFix(
  tx: Tx,
  fix: DqFix,
): Promise<{ ok: true; changes: string[] } | { ok: false; reason: string }> {
  if (fix.type === "NONE") return { ok: false, reason: "This issue needs a person to resolve it." };
  if (fix.type === "NORMALIZE_EMAIL") {
    const c = await tx.contact.findUnique({ where: { id: fix.contactId } });
    if (!c || c.email?.trim().toLowerCase() !== fix.email) {
      return { ok: false, reason: "The contact changed since the scan. Run the scan again." };
    }
    return {
      ok: true,
      changes: [`Change ${c.name}'s email from ${quoted(c.email)} to ${quoted(fix.email)}.`],
    };
  }
  const ids = [fix.keepId, ...fix.removeIds];
  const records = await tx.contact.findMany({ where: { id: { in: ids } } });
  const keep = records.find((c) => c.id === fix.keepId);
  if (!keep || records.length !== ids.length || records.some((c) => c.accountId !== keep.accountId))
    return { ok: false, reason: "These contacts changed since the scan. Run the scan again." };
  const removeIds = fix.removeIds;
  const [roles, messages, tickets, usage, refs] = await Promise.all([
    tx.stakeholderRole.count({ where: { contactId: { in: removeIds } } }),
    tx.message.count({ where: { fromContactId: { in: removeIds } } }),
    tx.ticket.count({ where: { contactId: { in: removeIds } } }),
    tx.userUsageDaily.count({ where: { contactId: { in: removeIds } } }),
    tx.externalRef.count({ where: { internalType: "Contact", internalId: { in: removeIds } } }),
  ]);
  const removed = records.filter((c) => c.id !== keep.id);
  const fills = fillFrom(keep, removed);
  return {
    ok: true,
    changes: [
      `Keep ${keep.name} (${quoted(keep.email)}).`,
      `Remove ${plural(removed.length, "duplicate record")}: ${removed.map((c) => `${c.name} (${quoted(c.email)})`).join(", ")}.`,
      `Move ${plural(roles, "role")}, ${plural(messages, "message")}, ${plural(tickets, "ticket")}, ${plural(usage, "usage row")} and ${plural(refs, "import reference")} onto the kept record.`,
      ...Object.entries(fills).map(
        ([field, value]) => `Fill the empty ${field} on the kept record with "${value}".`,
      ),
      ...(keep.email && keep.email !== keep.email.trim().toLowerCase()
        ? [`Change the kept email to ${quoted(keep.email.trim().toLowerCase())}.`]
        : []),
    ],
  };
}

type ContactRow = {
  email: string | null;
  title: string | null;
  timezone: string | null;
  externalUserId: string | null;
};
/** Empty fields on the kept record take the first value a duplicate has. Nothing is overwritten. */
function fillFrom(keep: ContactRow, removed: ContactRow[]) {
  const out: Partial<Record<keyof ContactRow, string>> = {};
  for (const field of ["email", "title", "timezone", "externalUserId"] as const) {
    if (keep[field]) continue;
    const value = removed.find((c) => c[field])?.[field];
    if (value) out[field] = field === "email" ? value.trim().toLowerCase() : value;
  }
  return out;
}

export interface FixPreviewItem {
  id: string;
  /** The issue's updatedAt when previewed; apply skips the issue if it has changed since. */
  version: string;
  kind: DataQualityIssue["kind"];
  detail: string;
  changes: string[];
}

export async function previewDataQualityFixes(actor: Actor, issueIds: string[]) {
  requirePermission(actor, "data:import");
  return scopedDb(actor).$tenantTransaction(async (tx) => {
    const issues = await tx.dataQualityIssue.findMany({
      where: { id: { in: issueIds }, status: "OPEN" },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    const items: FixPreviewItem[] = [];
    const notFixable: Array<{ id: string; reason: string }> = [];
    // Merges sort first; a later fix on a record one of them removes is left out, so
    // "Confirm all" never reports a skip it could have predicted.
    const removed = new Set<string>();
    for (const issue of issues) {
      const fix = dqFix.parse(issue.suggestedFix);
      const touches = fix.type === "MERGE_CONTACTS" ? [fix.keepId, ...fix.removeIds] : [];
      if (fix.type === "NORMALIZE_EMAIL") touches.push(fix.contactId);
      if (touches.some((id) => removed.has(id))) {
        notFixable.push({
          id: issue.id,
          reason: "A merge above removes this record, so this fix isn't needed.",
        });
        continue;
      }
      const d = await describeFix(tx, fix);
      if (fix.type === "MERGE_CONTACTS" && d.ok) fix.removeIds.forEach((id) => removed.add(id));
      if (d.ok) {
        items.push({
          id: issue.id,
          version: issue.updatedAt.toISOString(),
          kind: issue.kind,
          detail: issue.detail,
          changes: d.changes,
        });
      } else notFixable.push({ id: issue.id, reason: d.reason });
    }
    return { items, notFixable };
  });
}

export const applyFixesInput = z.object({
  confirm: z.literal(true),
  items: z
    .array(z.object({ id: z.string().min(1), version: z.string().min(1) }))
    .min(1)
    .max(500),
});

/** Applies exactly the previewed issues. Each one is its own transaction with its own audit row. */
export async function applyDataQualityFixes(actor: Actor, raw: unknown) {
  requirePermission(actor, "data:import");
  const input = applyFixesInput.parse(raw);
  const db = scopedDb(actor);
  const applied: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const item of input.items) {
    const outcome = await db.$tenantTransaction(async (tx) => {
      const issue = await tx.dataQualityIssue.findUnique({ where: { id: item.id } });
      if (!issue) return "Issue not found.";
      if (issue.status !== "OPEN") return `Issue is ${issue.status.toLowerCase()} now.`;
      if (issue.updatedAt.toISOString() !== item.version)
        return "Issue changed since the preview. Preview it again.";
      const fix = dqFix.parse(issue.suggestedFix);
      const d = await describeFix(tx, fix);
      if (!d.ok) return d.reason;
      if (fix.type === "MERGE_CONTACTS") await mergeContacts(tx, fix);
      if (fix.type === "NORMALIZE_EMAIL")
        await tx.contact.update({ where: { id: fix.contactId }, data: { email: fix.email } });
      const now = new Date();
      await tx.dataQualityIssue.update({
        where: { id: issue.id },
        data: { status: "FIXED", fixedByMembershipId: actor.membershipId, fixedAt: now },
      });
      if (fix.type === "MERGE_CONTACTS") {
        // Other open issues about the removed records no longer apply.
        await tx.dataQualityIssue.updateMany({
          where: { status: "OPEN", contactId: { in: fix.removeIds } },
          data: { status: "RESOLVED" },
        });
      }
      await writeAudit(
        {
          workspaceId: actor.workspaceId,
          actorType: "USER",
          actorId: actor.userId,
          action: "data_quality.fixed",
          targetType: "DataQualityIssue",
          targetId: issue.id,
          summary: `Fixed: ${issue.detail}`,
          before: { fix },
          after: { changes: d.changes },
        },
        tx,
      );
      return null;
    });
    if (outcome) skipped.push({ id: item.id, reason: outcome });
    else applied.push(item.id);
  }
  return { applied, skipped };
}

async function mergeContacts(tx: Tx, fix: Extract<DqFix, { type: "MERGE_CONTACTS" }>) {
  const { keepId, removeIds } = fix;
  const records = await tx.contact.findMany({ where: { id: { in: [keepId, ...removeIds] } } });
  const keep = records.find((c) => c.id === keepId)!;
  const removed = records.filter((c) => c.id !== keepId);

  // An open role the kept record already holds is closed on the duplicate, not doubled.
  const keptOpen = await tx.stakeholderRole.findMany({
    where: { contactId: keepId, validTo: null },
    select: { role: true },
  });
  await tx.stakeholderRole.updateMany({
    where: {
      contactId: { in: removeIds },
      validTo: null,
      role: { in: keptOpen.map((r) => r.role) },
    },
    data: { validTo: new Date() },
  });
  await tx.stakeholderRole.updateMany({
    where: { contactId: { in: removeIds } },
    data: { contactId: keepId },
  });
  await tx.message.updateMany({
    where: { fromContactId: { in: removeIds } },
    data: { fromContactId: keepId },
  });
  await tx.ticket.updateMany({
    where: { contactId: { in: removeIds } },
    data: { contactId: keepId },
  });
  await tx.userUsageDaily.updateMany({
    where: { contactId: { in: removeIds } },
    data: { contactId: keepId },
  });
  await tx.externalRef.updateMany({
    where: { internalType: "Contact", internalId: { in: removeIds } },
    data: { internalId: keepId },
  });
  const lastContactAt = [keep, ...removed]
    .map((c) => c.lastContactAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  await tx.contact.deleteMany({ where: { id: { in: removeIds } } });
  await tx.contact.update({
    where: { id: keepId },
    data: {
      ...fillFrom(keep, removed),
      ...(keep.email ? { email: keep.email.trim().toLowerCase() } : {}),
      lastContactAt: lastContactAt ?? null,
    },
  });
}
