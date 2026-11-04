/**
 * The M9 scenarios, run against the freshly seeded scratch database (see demo-m9.ts). Everything
 * goes through the real services and the real agent executor; the only stand-in is the model's
 * answer for the Support Risk Agent (a scripted provider, demo tooling like the seed's recorded
 * Watcher answers), whose output is still checked by the real judge and gates.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AiProvider } from "../src/lib/ai";
import { rawDb } from "../src/lib/db/raw";
import { closeQueues } from "../src/lib/jobs/queues";
import { scopedDb } from "../src/lib/db/scoped";
import { getAgent, runAgent } from "../src/modules/agents/service";
import { dispatch } from "../src/modules/outbound/service";
import { publishPlay } from "../src/modules/plays/service";
import { processPlaySignalOpened } from "../src/modules/plays/runner";
import { syncInbox } from "../src/modules/inbox/service";

const line = (s = "") => console.log(s);
const head = (s: string) => {
  line("\n" + "-".repeat(78));
  line(s);
  line("-".repeat(78));
};

async function main() {
  const ws = await rawDb.workspace.findFirstOrThrow({ where: { slug: "larkspur-demo" } });
  const db = scopedDb({ workspaceId: ws.id });
  const workspaceId = ws.id;
  const admin = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true) /* "workspaceId" = ${workspaceId} */`;
    return tx.membership.findFirstOrThrow({
      where: { workspaceId: ws.id, role: "ADMIN" },
      include: { user: true },
    });
  });
  const actor = {
    workspaceId: ws.id,
    userId: admin.userId,
    membershipId: admin.id,
    role: admin.role,
    canViewRevenue: admin.canViewRevenue,
    bookScope: admin.bookScope,
    user: { id: admin.user.id, email: admin.user.email, name: admin.user.name },
  };
  const account = (name: string) => db.account.findFirstOrThrow({ where: { name } });
  const halden = await account("Halden Retail");
  const northgate = await account("Northgate Freight");
  const quillmark = await account("Quillmark Legal");

  head("1. The Watcher read a seeded call; the promise carries its verified quote");
  const transcript = await db.callTranscript.findFirstOrThrow({ where: { accountId: halden.id } });
  const ext = await db.extraction.findFirstOrThrow({
    where: { accountId: halden.id, kind: "PROMISE" },
  });
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: ext.agentRunId } });
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  line(`call:        ${transcript.title}`);
  line(
    `agent run:   ${run.agentKey} ${run.agentVersion}, prompt ${run.promptName}@${run.promptVersion}, ${run.status}`,
  );
  line(`extraction:  ${ext.kind}  “${ext.quote}”  (confidence ${ext.confidence})`);
  line(`verbatim in the call text: ${norm(transcript.text).includes(norm(ext.quote))}`);
  const dropped = await db.agentRun
    .count({
      where: { agentKey: "watcher", effects: { path: [], string_contains: "DroppedExtraction" } },
    })
    .catch(() => -1);
  line(`story-source runs that dropped a quote: ${dropped}`);

  head("2. Halden's promise reads Late, computed by code from the date");
  const promise = await db.promise.findFirstOrThrow({ where: { accountId: halden.id } });
  line(
    `promise:     ${promise.what} (${promise.party}, due ${promise.dueDate?.toISOString().slice(0, 10)})`,
  );
  line(`status:      ${promise.status} — ${promise.statusReason}`);
  line(`proof:       ${promise.sourceType} ${promise.sourceId}, quote “${promise.quote}”`);

  head("3. Promise Late is publishable and enters on its signal");
  const play = await db.play.findFirstOrThrow({ where: { key: "promise-late" } });
  line(`status before: ${play.status}`);
  const pub = await publishPlay(actor, play.id);
  line(
    `publish:       ${pub.status}${pub.status === "REFUSED" ? " " + pub.refusals.join("; ") : ""}`,
  );
  const signal = await db.signal.findFirstOrThrow({
    where: {
      accountId: halden.id,
      ruleKey: "promise_late",
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
    },
  });
  line(`signal:        ${signal.severity} “${signal.title}”`);
  const entered = await processPlaySignalOpened({
    workspaceId: ws.id,
    accountId: halden.id,
    signalId: signal.id,
    ruleKey: "promise_late",
  });
  line(`entered play:  ${entered.entered.length === 1 ? "yes (1 run)" : "NO"}`);
  const prun = await db.playRun.findFirst({
    where: { playId: play.id, accountId: halden.id },
    include: { stepRuns: true },
  });
  line(
    `run:           ${prun?.status}; steps: ${prun?.stepRuns.map((s) => `${s.stepKey}=${s.status}`).join(", ")}`,
  );

  head("4. A reply drafted from a sensitive message is capped at draft-for-approval");
  await syncInbox({ workspaceId: ws.id }, { now: new Date("2026-11-02T17:00:00Z") });
  const item = await db.inboxItem.findFirstOrThrow({
    where: { accountId: quillmark.id, sourceType: "TICKET" },
  });
  const ticketMsg = await db.message.findFirstOrThrow({
    where: {
      accountId: quillmark.id,
      direction: "INBOUND",
      bodyText: { contains: "before we cancel" },
    },
  });
  const provider: AiProvider = {
    name: "recorded",
    async generateStructured<T>() {
      return {
        output: {
          reasoningSummary: "The customer asked to export their data before cancelling.",
          confidence: 0.8,
          proposedActions: [],
          citations: [{ sourceType: "Message", sourceId: ticketMsg.id }],
          riskNarrative:
            "Quillmark asked how to export all their data before they cancel at the end of the term: a cancellation risk that needs a person.",
          reply: {
            subject: "Re: Exporting our data",
            body: "Hi Grace,\n\nThank you for asking. A member of our team will come back to you personally today about getting your data out, and I would be glad to talk it through on a call.\n\nBest,\nLeo",
          },
        } as T,
        stopReason: "end_turn",
        model: "scripted-demo",
        requestId: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      };
    },
  };
  const out = await runAgent(
    actor,
    getAgent("support-risk"),
    { inboxItemId: item.id, requestedByMembershipId: actor.membershipId, nonce: "demo" },
    { type: "inbox", id: `${item.id}:demo` },
    { provider },
  );
  line(`agent run:     ${out.kind === "run" ? out.status : out.kind}`);
  const approval = await db.approval.findFirstOrThrow({
    where: { accountId: quillmark.id, kind: "SEND_EMAIL" },
    orderBy: { createdAt: "desc" },
  });
  line(
    `approval:      ${approval.status}, level ${approval.requiredLevel}, sensitive=${approval.isSensitive} (${approval.sensitiveReasons.join(", ")})`,
  );
  const draft = await db.outboundMessage.findFirstOrThrow({ where: { approvalId: approval.id } });
  line(
    `draft:         ${draft.status}, to the requester, proof cites ${JSON.stringify((approval.proof as Array<{ sourceId?: string }>).map((p) => p.sourceId).filter(Boolean))}`,
  );
  await db.outboundMessage.update({ where: { id: draft.id }, data: { sendMode: "AUTO" } });
  const sent: string[] = [];
  const attempt = await dispatch(actor, draft.id, {
    transport: {
      name: "log",
      async send(m) {
        sent.push(m.to);
        return { id: "x" };
      },
    },
  }).then(
    (r) => `result ${(r as { status: string }).status}`,
    (e: Error) => `refused: ${e.message.slice(0, 90)}`,
  );
  line(`forced AUTO dispatch: ${attempt}; emails sent: ${sent.length}`);

  head("5. Northgate: the late promise and the renewal concern, with their sources");
  const np = await db.promise.findFirstOrThrow({ where: { accountId: northgate.id } });
  line(`promise:       ${np.what}: ${np.status} — ${np.statusReason}`);
  line(`               “${np.quote}” (${np.sourceType})`);
  const signals = await db.signal.findMany({
    where: {
      accountId: northgate.id,
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
      ruleKey: { in: ["renewal_concern", "promise_late", "budget_concern"] },
    },
    orderBy: { ruleKey: "asc" },
  });
  for (const s of signals) {
    line(`signal:        ${s.ruleKey} ${s.severity} — ${s.title}`);
    for (const e of s.evidence as Array<{
      sourceType: string;
      sourceId?: string;
      value?: unknown;
      date?: string;
    }>)
      line(
        `               source ${e.sourceType} ${e.sourceId ?? ""} ${e.date ?? ""} ${typeof e.value === "string" ? `“${e.value}”` : ""}`,
      );
  }
  const renewal = await db.renewal.findFirstOrThrow({ where: { accountId: northgate.id } });
  line(
    `renewal confidence unchanged by M9: ${renewal.confidence} (${renewal.confidenceBand}), the shipped model counts health band and notice only (D-118/D-120)`,
  );

  head("Risk 1: seeded health numbers against the M8 baseline");
  const base = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "prisma/seed/__tests__/fixtures/m8-health-baseline.json"),
      "utf8",
    ),
  ) as {
    snapshots: Array<Record<string, string | null>>;
    renewals: Array<{
      accountId: string;
      contractId: string;
      confidence: number;
      confidenceBand: string;
    }>;
  };
  const snaps = await db.healthScoreSnapshot.findMany({
    where: { isBacktest: false },
    orderBy: [{ accountId: "asc" }, { asOf: "desc" }, { createdAt: "desc" }],
  });
  const latest = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) if (!latest.has(s.accountId)) latest.set(s.accountId, s);
  let same = 0;
  for (const b of base.snapshots) {
    const s = latest.get(b.accountId!);
    if (
      s &&
      String(s.overall) === String(b.overall) &&
      s.riskLevel === b.riskLevel &&
      String(s.adoption) === String(b.adoption) &&
      String(s.sentiment) === String(b.sentiment)
    )
      same++;
  }
  const ren = await db.renewal.findMany({ orderBy: [{ accountId: "asc" }, { contractId: "asc" }] });
  const renSame = base.renewals.filter(
    (b, i) =>
      ren[i]?.accountId === b.accountId &&
      ren[i]?.confidence === b.confidence &&
      ren[i]?.confidenceBand === b.confidenceBand,
  ).length;
  line(
    `snapshots matching the baseline (overall, adoption, sentiment, risk level): ${same} of ${base.snapshots.length}`,
  );
  line(
    `renewal confidences matching: ${renSame} of ${base.renewals.length}; Northgate ${renewal.confidence}`,
  );
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await rawDb.$disconnect();
  });
