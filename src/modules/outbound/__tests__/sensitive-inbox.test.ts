import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/ai";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { addExtraction } from "@/test/extraction-fixtures";
import { getAgent, runAgent } from "@/modules/agents/service";
import { syncInbox } from "@/modules/inbox/service";
import { dispatch, type DispatchDeps } from "../service";

type CustomerTransport = NonNullable<DispatchDeps["transport"]>;

/**
 * M9 rule 3 / acceptance #7: an inbound cancel / pricing / legal / security / complaint /
 * escalation message gets a draft only: the approval is sensitive, its level can never be lifted
 * above DRAFT_FOR_APPROVAL (by code or by the database), and dispatching it in AUTO mode sends
 * nothing, even with auto-send switched on for a long-tail account.
 */
const CASES: Array<[string, string, string]> = [
  [
    "cancellation",
    "How do I export all our data before we cancel at the end of the term?",
    "cancellation",
  ],
  ["pricing", "Can you give us a discount on the annual plan? The price went up.", "pricing"],
  ["legal", "Our lawyer asked who the data processor is under the contract terms.", "legal"],
  ["security", "We think there was a security incident involving our users' data.", "security"],
  [
    "complaint",
    "This is unacceptable. The export has failed three times and we are very disappointed.",
    "complaint",
  ],
  ["escalation", "Please escalate this to your manager today.", "escalation"],
];

describe("inbound sensitive messages never reach a send without a person", () => {
  it.each(CASES)(
    "%s: sensitive draft, capped at DRAFT_FOR_APPROVAL, AUTO dispatch sends nothing",
    async (_n, body, reason) => {
      const { actor } = await createTestAdmin(`SensInbox${reason}`);
      const db = scopedDb(actor);
      const ws = actor.workspaceId;
      // Long-tail, auto-send ON: the loosest setting there is.
      await db.workspaceSettings.upsert({
        where: { workspaceId: ws },
        create: { workspaceId: ws, data: { outbound: { autoSendEnabled: true } } },
        update: { data: { outbound: { autoSendEnabled: true } } },
      });
      const account = await db.account.create({
        data: {
          workspaceId: ws,
          name: "Quillmark",
          tier: "LONG_TAIL",
          domain: "q.test",
          ownerMembershipId: actor.membershipId,
        },
      });
      const contact = await db.contact.create({
        data: { workspaceId: ws, accountId: account.id, name: "Grace Lin", email: "grace@q.test" },
      });
      const conv = await db.conversation.create({
        data: {
          workspaceId: ws,
          accountId: account.id,
          channel: "EMAIL",
          subject: "Hello",
          startedAt: new Date("2026-11-01"),
          lastMessageAt: new Date("2026-11-01"),
        },
      });
      const msg = await db.message.create({
        data: {
          workspaceId: ws,
          accountId: account.id,
          conversationId: conv.id,
          direction: "INBOUND",
          fromContactId: contact.id,
          fromAddress: "grace@q.test",
          sentAt: new Date("2026-11-01T10:00:00Z"),
          subject: "Hello",
          bodyText: body,
        },
      });
      await addExtraction(db, {
        workspaceId: ws,
        accountId: account.id,
        sourceType: "MESSAGE",
        sourceId: msg.id,
        kind: "INTENT",
        quote: body.slice(0, 20),
        payload: { intent: reason },
      });
      await syncInbox(actor, { now: new Date("2026-11-02T12:00:00Z") });
      const item = await db.inboxItem.findFirstOrThrow({ where: { sourceId: msg.id } });
      const provider: AiProvider = {
        name: "recorded",
        async generateStructured<T>() {
          return {
            output: {
              reasoningSummary: "r",
              confidence: 0.8,
              proposedActions: [],
              citations: [{ sourceType: "Message", sourceId: msg.id }],
              riskNarrative: "The customer raised a sensitive topic.",
              reply: {
                subject: "Re: Hello",
                body: "Hi Grace,\n\nThank you for writing. A member of our team will come back to you personally today.\n\nBest",
              },
            } as T,
            stopReason: "end_turn",
            model: "recorded",
            requestId: null,
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
          };
        },
      };
      await runAgent(
        actor,
        getAgent("support-risk"),
        { inboxItemId: item.id, nonce: "n" },
        { type: "inbox", id: `${item.id}:n` },
        { provider },
      );

      const approval = await db.approval.findFirstOrThrow({ where: { accountId: account.id } });
      expect(approval.isSensitive).toBe(true);
      expect(approval.sensitiveReasons).toContain(reason);
      expect(approval.requiredLevel).toBe("DRAFT_FOR_APPROVAL");
      expect(approval.status).toBe("PENDING");

      // The database refuses to lift it.
      await expect(
        rawDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
          await tx.approval.update({
            where: { id: approval.id },
            data: { requiredLevel: "SEND_AUTOMATICALLY" },
          });
        }),
      ).rejects.toBeDefined();

      // Forcing the message into AUTO mode still sends nothing.
      const draft = await db.outboundMessage.findFirstOrThrow({
        where: { approvalId: approval.id },
      });
      await db.outboundMessage.update({ where: { id: draft.id }, data: { sendMode: "AUTO" } });
      const sent: string[] = [];
      const transport: CustomerTransport = {
        name: "log",
        async send(m) {
          sent.push(m.to);
          return { id: "x" };
        },
      };
      const result = await dispatch(actor, draft.id, { transport }).then(
        (r) => r,
        (e: unknown) => e,
      );
      expect(result instanceof Error || (result as { status?: string }).status === "HELD").toBe(
        true,
      );
      expect(sent).toEqual([]);
      expect(
        (await db.outboundMessage.findUniqueOrThrow({ where: { id: draft.id } })).status,
      ).not.toBe("SENT");
    },
  );
});
