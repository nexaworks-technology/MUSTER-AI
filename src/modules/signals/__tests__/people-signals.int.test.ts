import { describe, expect, it } from "vitest";
import { utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { evaluateAndStore } from "../service";

/** People rules through the real lifecycle (M9 A6): the database stamps a title change, the rule reads it. */
const ASOF = "2026-11-02";
const clock = () => new Date("2026-11-02T03:00:00Z");

describe("people signals through the lifecycle", () => {
  it("a title change on the champion opens champion_role_change; a typo-free no-op does not", async () => {
    const { actor } = await createTestAdmin("PeopleRC");
    const db = scopedDb(actor);
    const ws = actor.workspaceId;
    const account = await db.account.create({
      data: { workspaceId: ws, name: "Brightwell", tier: "HIGH_TOUCH" },
    });
    const maya = await db.contact.create({
      data: { workspaceId: ws, accountId: account.id, name: "Maya Ortiz", title: "Ops Lead" },
    });
    await db.stakeholderRole.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        contactId: maya.id,
        role: "CHAMPION",
        validFrom: utcMidnight("2025-01-01"),
      },
    });
    await db.contact.update({ where: { id: maya.id }, data: { name: "Maya Ortiz" } });
    await evaluateAndStore(actor, [account.id], ASOF, clock);
    expect(
      await db.signal.count({ where: { accountId: account.id, ruleKey: "champion_role_change" } }),
    ).toBe(0);
    await db.contact.update({ where: { id: maya.id }, data: { title: "VP Operations" } });
    // The stamp is "now" in real time; evaluate as of today's real date so it is inside the window.
    const today = new Date().toISOString().slice(0, 10);
    await evaluateAndStore(actor, [account.id], today, () => new Date());
    const s = await db.signal.findMany({
      where: { accountId: account.id, ruleKey: "champion_role_change" },
    });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ severity: "WARN", category: "PEOPLE" });
    expect(s[0]!.explanation).toMatch(/inside the same company/);
  });
});
