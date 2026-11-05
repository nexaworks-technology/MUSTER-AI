import { expect } from "@playwright/test";
import { inWorkspace, runScript } from "./m4";

export const REC = { AI_PROVIDER: "recorded", AI_RECORDINGS_DIR: ".dev-recordings/e2e-m11" };

/**
 * M11 e2e data, built by the real scripts before any browser step (no AI provider in the app):
 * Ask AI demo questions (recorded transport, once), the live save chain on Northbrook Fabrication (idempotent) and the
 * weekly digest (once per week). Safe to call from several spec files.
 */
export async function ensureM11Data(workspace: string): Promise<{ saveRecordPath: string }> {
  const haveAsk = await inWorkspace(workspace, (tx, ws) =>
    tx.askMessage.count({
      where: { workspaceId: ws, content: { contains: "mentioned a competitor" } },
    }),
  );
  // Seeding resets the play to DRAFT, so ask again whenever it is not published (the script
  // publishes it first, as a person would, with no retroactive enrolment).
  const published = await inWorkspace(workspace, (tx, ws) =>
    tx.play.count({ where: { workspaceId: ws, key: "renewal-risk", status: "PUBLISHED" } }),
  );
  const pending = await inWorkspace(workspace, (tx, ws) =>
    tx.approval.count({ where: { workspaceId: ws, kind: "BULK_ACTION", status: "PENDING" } }),
  );
  if (!haveAsk || !published || !pending) {
    // A previous e2e run on this database left runs started from an Ask confirmation; the seed
    // does not remove them and the flow below must start from none.
    await inWorkspace(workspace, async (tx, ws) => {
      const runs = await tx.playRun.findMany({
        where: { workspaceId: ws, triggerRef: { startsWith: "approval:" } },
        select: { id: true },
      });
      const ids = runs.map((r) => r.id);
      await tx.playStepRun.deleteMany({ where: { workspaceId: ws, playRunId: { in: ids } } });
      await tx.playRun.deleteMany({ where: { workspaceId: ws, id: { in: ids } } });
    });
    const ask = runScript(
      "scripts/recorded-ask.ts",
      ["--workspace", workspace, "--publish-play", "renewal-risk"],
      REC,
    );
    expect(ask).toContain("SUCCEEDED");
  }
  const chain = runScript("scripts/demo-m11-save-chain.ts", [
    "--workspace",
    workspace,
    // Outside the 90-day radar: a recorded renewal is append-only and M7's radar test asserts
    // the open renewals inside it (this spec sorts before m7-… in Playwright's file order).
    "--account",
    "Northbrook Fabrication",
  ]);
  const saveRecordPath = /save record: (\/reports\/outcomes\/\S+)/.exec(chain)![1]!;
  runScript("scripts/leader-digest.ts", ["--workspace", workspace], REC);
  return { saveRecordPath };
}
