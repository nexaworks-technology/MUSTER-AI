import type { ScopedDb } from "@/lib/db/scoped";
import { daysAgo, daysFromNow } from "./dates";
import { ids, seedId } from "./ids";

/**
 * Note templates, a few human notes on story accounts and open tasks (two overdue) for the
 * CSMs. Notes are human-written raw evidence; nothing here is AI output.
 */
const TEMPLATES = [
  {
    key: "checkin",
    name: "Check-in call",
    callType: "check-in",
    body: "Attendees:\nWhat's going well:\nWhat's blocking them:\nNext steps:",
  },
  {
    key: "qbr",
    name: "QBR prep",
    callType: "qbr",
    body: "Goals since last review:\nResults:\nRisks:\nAsks for next quarter:",
  },
  {
    key: "kickoff",
    name: "Onboarding kickoff",
    callType: "onboarding",
    body: "Success looks like:\nKey people:\nSetup steps and owners:\nTarget date for first value:",
  },
] as const;

const NOTES = [
  {
    key: "brightwell-1",
    account: "brightwell",
    author: "leo",
    daysAgo: 10,
    tags: ["champion"],
    body: "Maya hasn't replied to my last three emails. Ben Okafor from finance is joining the calls now, so I need to build that relationship.",
  },
  {
    key: "halden-1",
    account: "halden",
    author: "leo",
    daysAgo: 31,
    tags: ["support", "export"],
    body: "Call with Elena and Marcus about the month-end export failures. Told them engineering is on it and I'd keep them posted.",
  },
  {
    key: "pinecrest-1",
    account: "pinecrest",
    author: "aisha",
    daysAgo: 12,
    tags: ["onboarding", "sso"],
    body: "SSO setup is waiting on Raj (their IT manager). Everything else from kickoff is done.",
  },
  {
    key: "tidewater-1",
    account: "tidewater",
    author: "leo",
    daysAgo: 6,
    tags: ["relationship"],
    body: "New VP Carla Diaz joined the call and was skeptical about the reporting rollout. Numbers look fine but I'm worried.",
  },
] as const;

const TASKS = [
  {
    key: "t1",
    owner: "leo",
    account: "northgate",
    title: "Prepare Northgate renewal plan",
    due: 5,
    priority: "HIGH",
  },
  {
    key: "t2",
    owner: "leo",
    account: "halden",
    title: "Follow up with Halden on the CSV export fix",
    due: -9,
    priority: "HIGH",
  },
  {
    key: "t3",
    owner: "leo",
    account: "brightwell",
    title: "Introduce myself to Ben Okafor",
    due: 2,
    priority: "NORMAL",
  },
  {
    key: "t4",
    owner: "aisha",
    account: "pinecrest",
    title: "Chase SSO setup with Pinecrest IT",
    due: -3,
    priority: "HIGH",
  },
  {
    key: "t5",
    owner: "aisha",
    account: "copperleaf",
    title: "Review Copperleaf seat usage",
    due: 7,
    priority: "NORMAL",
  },
] as const;

export async function seedWork(db: ScopedDb, workspaceId: string): Promise<void> {
  for (const t of TEMPLATES) {
    const data = { name: t.name, callType: t.callType, body: t.body };
    await db.noteTemplate.upsert({
      where: { id: seedId(`template:${t.key}`) },
      create: { id: seedId(`template:${t.key}`), workspaceId, ...data },
      update: data,
    });
  }
  for (const n of NOTES) {
    const data = {
      accountId: ids.account(n.account),
      authorMembershipId: ids.membership(n.author),
      body: n.body,
      tags: [...n.tags],
      origin: "HUMAN" as const,
      source: "SEED" as const,
      createdAt: daysAgo(n.daysAgo),
    };
    await db.note.upsert({
      where: { id: seedId(`note:${n.key}`) },
      create: { id: seedId(`note:${n.key}`), workspaceId, ...data },
      update: data,
    });
  }
  for (const t of TASKS) {
    const data = {
      accountId: ids.account(t.account),
      title: t.title,
      ownerMembershipId: ids.membership(t.owner),
      createdByMembershipId: ids.membership(t.owner),
      dueAt: t.due < 0 ? daysAgo(-t.due) : daysFromNow(t.due),
      priority: t.priority,
      status: "OPEN" as const,
      completedAt: null,
      origin: "HUMAN" as const,
      source: "SEED" as const,
      createdAt: daysAgo(14),
    };
    await db.task.upsert({
      where: { id: seedId(`task:${t.key}`) },
      create: { id: seedId(`task:${t.key}`), workspaceId, ...data },
      update: data,
    });
  }
}
