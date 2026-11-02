import { readFileSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import type { ScopedDb } from "@/lib/db/scoped";
import { TRANSCRIPTS } from "../fixtures/make-transcripts";
import { contactEmail } from "./accounts";
import { atHour, daysAgo } from "./dates";
import { ids, seedId } from "./ids";
import { createRng } from "./random";
import { accountByKey, ROSTER, type AccountSpec } from "./roster";

/**
 * Emails, tickets and call transcripts (docs/SEED_DATA.md §5). Planted lines are verbatim.
 * Text is raw evidence only: no sentiment, promise or goal is stored here — those come from
 * extraction in M4/M9 (D-28). Replaced wholesale on every run, with fixed ids.
 */
const SEED_TODAY_DAY = 0;
const csmFor = (a: AccountSpec) =>
  a.owner === "aisha"
    ? { name: "Aisha Bello", email: "aisha@larkspur.test", member: ids.membership("aisha") }
    : { name: "Leo Marsh", email: "leo@larkspur.test", member: ids.membership("leo") };

const CHECKIN = [
  {
    subject: "Checking in on the new dashboards",
    out: "Hi {first}, I wanted to check how the team is getting on with the dashboards you set up last month. Happy to walk anyone through them on a short call.",
    in: "Hi {csm}, thanks for checking in. The team is using them every morning now. I'll shout if we need a walkthrough.",
  },
  {
    subject: "Training session on Thursday",
    out: "Hi {first}, we're running a training session on scheduled reports this Thursday. Would anyone on your team like to join?",
    in: "Thanks {csm}, I've forwarded it to two of our analysts.",
  },
  {
    subject: "Notes from our call",
    out: "Hi {first}, here are the notes from our call. Let me know if I missed anything.",
    in: "Looks good, thanks for sending these over.",
  },
  {
    subject: "New filter options",
    out: "Hi {first}, we shipped new filter options this week. They should make the regional views quicker to build.",
    in: "Nice, I'll have a look this week.",
  },
  {
    subject: "Access for new team members",
    out: "Hi {first}, I noticed a few new people joined your workspace. Do they need any help getting set up?",
    in: "They're fine for now, thanks for keeping an eye on it.",
  },
];

const TICKET_SUBJECTS = [
  [
    "How do I share a dashboard with a read-only user?",
    "Hi, how do I share a dashboard with someone who should only be able to view it?",
  ],
  ["Changing the default date range", "Where can I change the default date range for a report?"],
  [
    "Adding a new site to an existing report",
    "We opened a new site. How do I add it to our existing weekly report?",
  ],
  ["Question about alert frequency", "Can alerts be sent once a day instead of every hour?"],
  ["Renaming a folder", "Is there a way to rename a folder without breaking the shared links?"],
  ["Export column order", "Can I choose the column order when exporting a table?"],
] as const;

export async function seedConversations(db: ScopedDb, workspaceId: string): Promise<void> {
  const rng = createRng(23);
  await db.callTranscript.deleteMany({ where: { source: "SEED" } });
  await db.ticket.deleteMany({ where: { source: "SEED" } });
  await db.message.deleteMany({ where: { source: "SEED" } });
  await db.conversation.deleteMany({ where: { source: "SEED" } });

  const conversations: Prisma.ConversationCreateManyInput[] = [];
  const messages: Prisma.MessageCreateManyInput[] = [];
  const tickets: Prisma.TicketCreateManyInput[] = [];
  const transcripts: Prisma.CallTranscriptCreateManyInput[] = [];

  const thread = (
    key: string,
    a: AccountSpec,
    channel: "EMAIL" | "CALL" | "TICKET",
    subject: string,
    at: Date,
    last: Date,
  ) => {
    const id = seedId(`conv:${key}`);
    conversations.push({
      id,
      workspaceId,
      accountId: ids.account(a.key),
      channel,
      subject,
      startedAt: at,
      lastMessageAt: last,
      source: "SEED",
    });
    return id;
  };
  const message = (
    key: string,
    convId: string,
    a: AccountSpec,
    dir: "INBOUND" | "OUTBOUND",
    at: Date,
    subject: string,
    body: string,
    from: { contactKey?: string; address?: string },
  ) => {
    const csm = csmFor(a);
    messages.push({
      id: seedId(`msg:${key}`),
      workspaceId,
      conversationId: convId,
      accountId: ids.account(a.key),
      direction: dir,
      fromContactId:
        dir === "INBOUND" && from.contactKey ? ids.contact(a.key, from.contactKey) : null,
      fromMembershipId: dir === "OUTBOUND" ? csm.member : null,
      fromAddress: from.address ?? (dir === "OUTBOUND" ? csm.email : null),
      toAddresses: [],
      sentAt: at,
      subject,
      bodyText: body,
      source: "SEED",
    });
  };

  // ── Email threads for high- and mid-touch accounts over 90 days ──
  for (const a of ROSTER.filter(
    (x) => x.tier !== "LONG_TAIL" && x.stage !== "LOST" && x.contacts.length > 0,
  )) {
    const csm = csmFor(a);
    const champion =
      a.contacts.find((c) =>
        c.roles.some((r) => r.role === "CHAMPION" && r.toDaysAgo === undefined),
      ) ?? a.contacts[0]!;
    const span = a.onboardingDay !== undefined ? Math.min(a.onboardingDay, 90) : 90;
    const gap = a.key === "glenmore" ? 30 : 9 + rng.int(0, 6);
    for (let d = span - 2, n = 0; d > 1; d -= gap, n++) {
      const t = CHECKIN[(n + a.key.length) % CHECKIN.length]!;
      const first = champion.name.split(" ")[0]!;
      const key = `${a.key}:checkin:${n}`;
      const out = atHour(daysAgo(d), 14, rng.int(0, 59));
      // Brightwell: Maya stops replying after day 44 (SEED_DATA §3).
      const replies = !(a.key === "brightwell" && d < 44) && rng.chance(0.85);
      const back = new Date(out.getTime() + rng.int(3, 30) * 3_600_000);
      const conv = thread(key, a, "EMAIL", t.subject, out, replies ? back : out);
      message(
        `${key}:out`,
        conv,
        a,
        "OUTBOUND",
        out,
        t.subject,
        t.out.replace("{first}", first),
        {},
      );
      if (replies)
        message(
          `${key}:in`,
          conv,
          a,
          "INBOUND",
          back,
          `Re: ${t.subject}`,
          t.in.replace("{csm}", csm.name.split(" ")[0]!),
          { contactKey: champion.key, address: contactEmail(a, champion.name) },
        );
    }
  }

  // ── Planted emails ──
  const brightwell = accountByKey("brightwell");
  {
    const conv = thread(
      "brightwell:bounce",
      brightwell,
      "EMAIL",
      "Quarterly review prep",
      atHour(daysAgo(6), 14),
      atHour(daysAgo(6), 14, 5),
    );
    message(
      "brightwell:bounce:out",
      conv,
      brightwell,
      "OUTBOUND",
      atHour(daysAgo(6), 14),
      "Quarterly review prep",
      "Hi Maya, could we find 30 minutes next week to prepare the quarterly review?",
      {},
    );
    message(
      "brightwell:bounce:in",
      conv,
      brightwell,
      "INBOUND",
      atHour(daysAgo(6), 14, 5),
      "Undeliverable: Quarterly review prep",
      "Delivery has failed to maya.ortiz@brightwell-logistics.test. The address does not exist or is no longer accepting mail.",
      { address: "mailer-daemon@brightwell-logistics.test" },
    );
  }
  const halden = accountByKey("halden");
  {
    const conv = thread(
      "halden:angry",
      halden,
      "EMAIL",
      "CSV export failed again",
      atHour(daysAgo(2), 13),
      atHour(daysAgo(2), 13),
    );
    message(
      "halden:angry:in",
      conv,
      halden,
      "INBOUND",
      atHour(daysAgo(2), 13),
      "CSV export failed again",
      "Hi Leo,\n\nThis is the third time the export has failed during month-end. We are losing patience.\n\nElena",
      { contactKey: "elena", address: contactEmail(halden, "Elena Voss") },
    );
  }
  const marlow = accountByKey("marlow-finch");
  {
    const conv = thread(
      "marlow:thanks",
      marlow,
      "EMAIL",
      "Month-end went smoothly",
      atHour(daysAgo(5), 15),
      atHour(daysAgo(5), 15),
    );
    message(
      "marlow:thanks:in",
      conv,
      marlow,
      "INBOUND",
      atHour(daysAgo(5), 15),
      "Month-end went smoothly",
      "Hi Leo, just a quick note to say the new close dashboard made this month-end much smoother for the whole finance team. Thank you!",
      { contactKey: "hugo", address: contactEmail(marlow, "Hugo Marlow") },
    );
  }
  for (const [i, key] of ["glenmore", "ashgrove", "copperleaf"].entries()) {
    const a = accountByKey(key);
    const c = a.contacts[0]!;
    const conv = thread(
      `howto:${key}`,
      a,
      "EMAIL",
      ["How do I schedule a report?", "How do I add a new user?", "How do I pin a dashboard?"][i]!,
      atHour(daysAgo(8 + i), 16),
      atHour(daysAgo(8 + i), 16),
    );
    message(
      `howto:${key}:in`,
      conv,
      a,
      "INBOUND",
      atHour(daysAgo(8 + i), 16),
      ["How do I schedule a report?", "How do I add a new user?", "How do I pin a dashboard?"][i]!,
      [
        "Hi, how do I schedule a report to go out every Monday morning?",
        "Hello, how do I add a new user to our workspace?",
        "Quick one: how do I pin a dashboard so it opens first?",
      ][i]!,
      { contactKey: c.key, address: contactEmail(a, c.name) },
    );
  }

  // ── Tickets (~180 days) ──
  let ticketNo = 1;
  const ticket = (
    a: AccountSpec,
    o: {
      subject: string;
      body: string;
      openedDaysAgo: number;
      priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
      escalated?: boolean;
      open?: boolean;
      contactKey?: string;
    },
  ) => {
    const key = `${a.key}:ticket:${ticketNo++}`;
    const opened = atHour(daysAgo(o.openedDaysAgo), 15, rng.int(0, 59));
    const reply = new Date(opened.getTime() + rng.int(1, 8) * 3_600_000);
    const closed = o.open ? null : new Date(opened.getTime() + rng.int(1, 5) * 86_400_000);
    const conv = thread(key, a, "TICKET", o.subject, opened, closed ?? reply);
    const contact = o.contactKey ?? a.contacts[0]?.key;
    message(`${key}:in`, conv, a, "INBOUND", opened, o.subject, o.body, {
      contactKey: contact,
      address: contact
        ? contactEmail(a, a.contacts.find((c) => c.key === contact)!.name)
        : undefined,
    });
    message(
      `${key}:reply`,
      conv,
      a,
      "OUTBOUND",
      reply,
      `Re: ${o.subject}`,
      "Thanks for getting in touch. We're looking into this and will update this ticket.",
      { address: "support@larkspur.test" },
    );
    tickets.push({
      id: seedId(`ticket:${key}`),
      workspaceId,
      accountId: ids.account(a.key),
      contactId: contact ? ids.contact(a.key, contact) : null,
      conversationId: conv,
      externalId: `T-${10000 + ticketNo}`,
      subject: o.subject,
      status: o.open ? "OPEN" : "CLOSED",
      priority: o.priority ?? "NORMAL",
      isEscalated: o.escalated ?? false,
      openedAt: opened,
      firstResponseAt: reply,
      closedAt: closed,
      source: "SEED",
    });
  };

  for (const a of ROSTER) {
    if (["halden", "quillmark", "ashgrove", "northgate"].includes(a.key)) continue; // planted below
    const perMonth = a.tier === "HIGH_TOUCH" ? 1.6 : a.tier === "MID_TOUCH" ? 0.6 : 0.25;
    const from =
      a.churnedDaysAgo !== undefined
        ? a.churnedDaysAgo + 180
        : Math.min(180, a.onboardingDay ?? 180);
    const to = a.churnedDaysAgo ?? SEED_TODAY_DAY;
    for (let d = from; d > to + 2; d -= 30) {
      const count = rng.chance(perMonth % 1) ? Math.ceil(perMonth) : Math.floor(perMonth);
      for (let k = 0; k < count; k++) {
        const [subject, body] = rng.pick(TICKET_SUBJECTS);
        const p = rng.next();
        ticket(a, {
          subject,
          body,
          openedDaysAgo: d - rng.int(0, 25),
          priority: p < 0.25 ? "LOW" : p < 0.85 ? "NORMAL" : p < 0.97 ? "HIGH" : "URGENT",
        });
      }
    }
    if (a.churnedDaysAgo !== undefined && a.story?.includes("support escalation")) {
      for (const before of [70, 55, 40]) {
        ticket(a, {
          subject: "Reports not loading for the operations team",
          body: "Our reports have not loaded for most of the morning again. This is blocking the team.",
          openedDaysAgo: a.churnedDaysAgo + before,
          priority: "URGENT",
          escalated: true,
        });
      }
    }
  }
  // Halden: the same CSV export problem three times in 26 days; the latest is open, high, escalated.
  for (const [d, open] of [
    [26, false],
    [15, false],
    [4, true],
  ] as const) {
    ticket(halden, {
      subject: "CSV export fails at month-end",
      body: "The CSV export of the stock report fails with a timeout when we run it at month-end.",
      openedDaysAgo: d,
      priority: open ? "HIGH" : "NORMAL",
      escalated: open,
      open,
      contactKey: "elena",
    });
  }
  ticket(accountByKey("quillmark"), {
    subject: "Exporting our data",
    body: "How do I export all our data before we cancel at the end of the term?",
    openedDaysAgo: 3,
    open: true,
    contactKey: "grace",
  });
  for (let i = 0; i < 6; i++) {
    ticket(accountByKey("ashgrove"), {
      subject: `Data migration: ${["plant A sensors", "plant B sensors", "maintenance logs", "shift reports", "quality checks", "downtime log"][i]} not appearing`,
      body: "After the migration, this data source is not showing up in our dashboards.",
      openedDaysAgo: 52 - i,
      priority: i < 2 ? "HIGH" : "NORMAL",
    });
  }
  ticket(accountByKey("northgate"), {
    subject: "API rate limit errors on nightly sync",
    body: "Our nightly sync is hitting API rate limit errors and stops halfway.",
    openedDaysAgo: 9,
    priority: "HIGH",
    open: true,
    contactKey: "ivan",
  });

  // ── Call transcripts (fixtures; the Brightwell post-call one is kept for the M10 upload demo) ──
  for (const t of TRANSCRIPTS.filter((x) => x.seeded)) {
    const a = accountByKey(t.account);
    const at = new Date(`${t.date}T15:00:00Z`);
    const text = readFileSync(
      path.join(import.meta.dirname, "../fixtures/transcripts", t.file),
      "utf8",
    );
    const conv = thread(`call:${t.file}`, a, "CALL", t.title, at, at);
    transcripts.push({
      id: seedId(`transcript:${t.file}`),
      workspaceId,
      conversationId: conv,
      accountId: ids.account(a.key),
      title: t.title,
      provider: "seed-fixture",
      occurredAt: at,
      text,
      durationSec: 1800 + (text.length % 900),
      source: "SEED",
    });
  }

  await db.conversation.createMany({ data: conversations });
  for (let i = 0; i < messages.length; i += 2000)
    await db.message.createMany({ data: messages.slice(i, i + 2000) });
  await db.ticket.createMany({ data: tickets });
  await db.callTranscript.createMany({ data: transcripts });
}
