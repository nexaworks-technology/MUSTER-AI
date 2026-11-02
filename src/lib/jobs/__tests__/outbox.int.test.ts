import { describe, expect, it, vi } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { dispatchOutbox, writeOutboxEvent, type Enqueue } from "@/lib/jobs/outbox";
import { createTestWorkspace } from "@/test/fixtures";

const TYPE = `test.event.${Date.now()}`;
const routes = { [TYPE]: { queue: "maintenance" as const, job: "heartbeat" } };

describe("transactional outbox (D-22)", () => {
  it("an event committed with its change is enqueued once with its workspaceId", async () => {
    const { workspace } = await createTestWorkspace("Outbox");
    const event = await scopedDb({ workspaceId: workspace.id }).$tenantTransaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorType: "SYSTEM",
          action: "test.change",
          summary: "change",
        },
      });
      return writeOutboxEvent(tx, {
        workspaceId: workspace.id,
        type: TYPE,
        payload: { thing: "x" },
      });
    });

    const enqueue = vi.fn<Enqueue>(async () => undefined);
    await dispatchOutbox(routes, { enqueue });
    expect(enqueue).toHaveBeenCalledWith(
      "maintenance",
      "heartbeat",
      { thing: "x", workspaceId: workspace.id, outboxEventId: event.id },
      `outbox-${event.id}`,
    );
    const stored = await rawDb.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(stored.processedAt).not.toBeNull();

    enqueue.mockClear();
    await dispatchOutbox(routes, { enqueue });
    expect(enqueue).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ outboxEventId: event.id }),
      expect.anything(),
    );
  });

  it("a rolled-back change emits no event", async () => {
    const { workspace } = await createTestWorkspace("OutboxRollback");
    await expect(
      scopedDb({ workspaceId: workspace.id }).$tenantTransaction(async (tx) => {
        await writeOutboxEvent(tx, { workspaceId: workspace.id, type: TYPE, payload: {} });
        throw new Error("change failed");
      }),
    ).rejects.toThrow("change failed");
    expect(await rawDb.outboxEvent.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it("an event with no registered route is kept, counted and explained", async () => {
    const { workspace } = await createTestWorkspace("OutboxUnrouted");
    const event = await scopedDb({ workspaceId: workspace.id }).$tenantTransaction((tx) =>
      writeOutboxEvent(tx, { workspaceId: workspace.id, type: "nobody.listens", payload: {} }),
    );
    await dispatchOutbox({}, { enqueue: async () => undefined });
    const stored = await rawDb.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(stored).toMatchObject({ processedAt: null, attempts: 1 });
    expect(stored.lastError).toMatch(/No handler is registered/);
  });
});
