import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { createTestAdmin } from "@/test/fixtures";

/**
 * Q-81: the M3 stamp triggers assign now() to TIMESTAMP(3) (no zone) columns. On a session whose
 * TimeZone is not UTC that stored the local wall clock, which Prisma reads as UTC. Each stamp must
 * be the UTC instant whatever the session zone is.
 */
const ZONES = ["Asia/Kolkata", "America/Los_Angeles"] as const;
const TOLERANCE_MS = 5_000;

function near(d: Date | null) {
  expect(d).not.toBeNull();
  expect(Math.abs((d as Date).getTime() - Date.now())).toBeLessThan(TOLERANCE_MS);
}

describe.each(ZONES)("stamp triggers store UTC under session time zone %s", (zone) => {
  it("contact.statusChangedAt, ticket.escalatedAt and ticket.priorityChangedAt", async () => {
    const { workspace } = await createTestAdmin("Utc");
    const workspaceId = workspace.id;
    await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);

      const account = await tx.account.create({
        data: { workspaceId, name: "Utc account", tier: "MID_TOUCH" },
      });

      // Contact: status change on update.
      const contact = await tx.contact.create({
        data: { workspaceId, accountId: account.id, name: "C" },
      });
      const changed = await tx.contact.update({
        where: { id: contact.id },
        data: { status: "LEFT" },
      });
      near(changed.statusChangedAt);
      // Contact: non-ACTIVE on insert.
      const left = await tx.contact.create({
        data: { workspaceId, accountId: account.id, name: "C2", status: "LEFT" },
      });
      near(left.statusChangedAt);

      // Ticket: escalation + priority change on update.
      const ticket = await tx.ticket.create({
        data: { workspaceId, accountId: account.id, subject: "S", openedAt: new Date() },
      });
      const upd = await tx.ticket.update({
        where: { id: ticket.id },
        data: { isEscalated: true, priority: "HIGH" },
      });
      near(upd.escalatedAt);
      near(upd.priorityChangedAt);
      // Ticket: escalated on insert.
      const esc = await tx.ticket.create({
        data: { workspaceId, accountId: account.id, subject: "S2", openedAt: new Date(), isEscalated: true },
      });
      near(esc.escalatedAt);
    });
  });
});
