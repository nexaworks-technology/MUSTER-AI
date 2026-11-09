/**
 * M12 Session C (C3): Live Ask AI eval against Anthropic Claude.
 * Runs the demo question set on larkspur-demo as Dana (Admin/CS Leader, with revenue permission).
 */
import { scopedDb } from "@/lib/db/scoped";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { askQuestion, type AskActor } from "@/modules/ask-ai/service";
import { publishPlay } from "@/modules/plays/service";
import { DEMO_QUESTIONS } from "./recorded-ask";

async function main() {
  const ws = await findWorkspaceBySlug("larkspur-demo");
  if (!ws) throw new Error("Workspace larkspur-demo not found");

  const db = scopedDb({ workspaceId: ws.id });
  const m = await db.membership.findFirstOrThrow({
    where: { user: { email: "dana@larkspur.test" } },
  });

  const actor: AskActor = {
    workspaceId: ws.id,
    userId: m.userId,
    membershipId: m.id,
    role: m.role,
    canViewRevenue: m.canViewRevenue,
    bookScope: m.bookScope,
  };

  // Ensure renewal-risk play is published so the proposal question can succeed
  const play = await db.play.findFirst({ where: { key: "renewal-risk" } });
  if (play && play.status !== "PUBLISHED") {
    await publishPlay(actor, play.id, { retroactive: false });
    console.log("Published play renewal-risk");
  }

  console.log("Starting Live Ask AI eval with live Anthropic model (tier: deep = claude-sonnet-4-6)...");

  for (const q of DEMO_QUESTIONS) {
    console.log(`\n========================================`);
    console.log(`QUESTION: "${q}"`);
    console.log(`ASKER: ${m.userId} (${actor.role}, canViewRevenue=${actor.canViewRevenue})`);
    const start = Date.now();
    try {
      const res = await askQuestion(actor, { question: q });
      const elapsed = Date.now() - start;
      console.log(`STATUS: ${res.status} (${elapsed}ms)`);
      console.log(`RUN ID: ${res.runId}`);
      if (res.threadId) {
        const thread = await db.askThread.findUnique({
          where: { id: res.threadId },
          include: { messages: true },
        });
        const assistantMsg = thread?.messages.find((x) => x.role === "ASSISTANT");
        if (assistantMsg) {
          console.log(`ANSWER CONTENT:\n${assistantMsg.content}`);
          console.log(`CITATIONS: ${JSON.stringify(assistantMsg.citations, null, 2)}`);
        }
      }
    } catch (err: unknown) {
      console.error(`ERROR on "${q}":`, err instanceof Error ? err.message : err);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Eval failed:", err);
    process.exit(1);
  });
