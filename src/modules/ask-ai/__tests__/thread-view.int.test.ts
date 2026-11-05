import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { countQueries } from "@/test/query-counter";
import { createTestAdmin } from "@/test/fixtures";
import { attachFile, loadThreadView, AskThreadNotFoundError, type AskActor } from "../service";

/** M11 S11: the /ask thread loader runs a fixed number of queries however long the thread is. */
let admin: AskActor;
let threadId: string;

async function addMessages(n: number) {
  const db = scopedDb(admin);
  for (let i = 0; i < n; i++)
    await db.askMessage.create({
      data: { workspaceId: admin.workspaceId, threadId, role: "USER", content: `Q${i}` },
    });
}

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("AskView"));
  const first = await attachFile(admin, {
    filename: "notes.txt",
    bytes: new TextEncoder().encode("hello"),
  });
  threadId = first.threadId;
});

describe("thread page loader", () => {
  it("uses the same number of queries with 2 messages as with 5 questions' worth", async () => {
    await addMessages(1);
    const small = await countQueries(() => loadThreadView(admin, threadId));
    await addMessages(4);
    const big = await countQueries(() => loadThreadView(admin, threadId));
    expect(big.result.messages.length).toBeGreaterThan(small.result.messages.length);
    expect(big.queries).toBe(small.queries);
    expect(big.result.files).toEqual([
      { id: expect.any(String), name: "notes.txt", scanned: true },
    ]);
  });

  it("someone else's thread does not exist", async () => {
    const { actor: other } = await createTestAdmin("AskViewOther");
    await expect(loadThreadView(other, threadId)).rejects.toBeInstanceOf(AskThreadNotFoundError);
  });
});
