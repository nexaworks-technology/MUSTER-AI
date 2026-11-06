import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createCampaign, getCampaign } from "@/modules/campaigns/service";
import { createTestAdmin } from "@/test/fixtures";

/**
 * M12 Session C (C0b): the campaign card labelled "Failed / Bounced" counted FAILED recipients
 * only. It now counts both, from the same recipient status the badges show (CampaignRecipient.status).
 */
let admin: Actor;
let db: ScopedDb;
let segmentId: string;

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("CampaignStats"));
  db = scopedDb(admin);
  const acct = await db.account.create({
    data: { workspaceId: admin.workspaceId, name: "Bounce Co", tier: "MID_TOUCH", timezone: "UTC" },
  });
  for (const n of ["Ana", "Ben"])
    await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: acct.id,
        name: n,
        email: `${n.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`,
        status: "ACTIVE",
      },
    });
  segmentId = (
    await db.segment.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Bounce segment",
        filter: { all: [{ field: "tier", op: "in", value: ["MID_TOUCH"] }] },
      },
    })
  ).id;
});

async function campaignWith(statuses: Array<"FAILED" | "BOUNCED">) {
  const c = await createCampaign(admin, {
    name: `Stats ${randomUUID().slice(0, 6)}`,
    segmentId,
    subject: "Hello",
    body: "Hello there",
    pacePerHour: 60,
  });
  const recipients = await db.campaignRecipient.findMany({
    where: { campaignId: c.id },
    orderBy: { id: "asc" },
  });
  expect(recipients).toHaveLength(statuses.length);
  for (const [i, r] of recipients.entries())
    await db.campaignRecipient.update({ where: { id: r.id }, data: { status: statuses[i]! } });
  return c.id;
}

describe("campaign stats: Failed / Bounced", () => {
  it("a bounced-only campaign shows every bounced recipient in the figure", async () => {
    const id = await campaignWith(["BOUNCED", "BOUNCED"]);
    const c = await getCampaign(admin, id);
    expect(c.recipients.map((r) => r.status)).toEqual(["BOUNCED", "BOUNCED"]);
    expect(c.stats.failed).toBe(2);
  });

  it("failed and bounced recipients are counted together", async () => {
    const id = await campaignWith(["FAILED", "BOUNCED"]);
    expect((await getCampaign(admin, id)).stats.failed).toBe(2);
  });
});
