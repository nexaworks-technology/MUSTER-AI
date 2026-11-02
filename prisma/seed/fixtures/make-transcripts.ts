/**
 * Writes the 14 call-transcript fixtures in prisma/seed/fixtures/transcripts/ (SEED_DATA §5,
 * DECISIONS D-43). Neutral conversation is composed deterministically from a curated line bank
 * that avoids every risk cue (no competitors, money, cancellation, complaints, dates promised),
 * so the 8 neutral transcripts are true negatives for M9 extraction tests. Planted lines are
 * inserted verbatim. Run: pnpm exec tsx prisma/seed/fixtures/make-transcripts.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRng } from "../demo/random";

export interface TranscriptSpec {
  file: string;
  account: string;
  title: string;
  date: string;
  csm: string;
  customer: string[];
  /** Planted lines, verbatim, with the speaker who says them. */
  planted: Array<{ speaker: string; line: string }>;
  /** Seeded into the database (false = kept as an upload fixture for a later demo). */
  seeded: boolean;
}

const CSM_LINES = [
  "Thanks for making the time today, it's good to catch up with everyone.",
  "Before we start, is there anything you'd like to make sure we cover in this call?",
  "Let me share my screen so we can look at the reporting setup together.",
  "That makes sense, and it matches what I saw in the workspace this morning.",
  "Can you walk me through how your team uses the weekly dashboard today?",
  "The notes from these calls go into the shared folder as usual.",
  "One thing I noticed is that the operations team has built several new views this month.",
  "There is a short guide in the help centre for people who joined recently.",
  "We have a training session on dashboards every Thursday, and anyone on your team is welcome.",
  "Let's look at the alert settings, because there are a couple of options you might find useful.",
  "Our support team handles configuration questions through the help centre.",
  "That's a good point, and other teams in your industry set it up the same way.",
  "Let me make a note of that so we can come back to it next time.",
  "Is the current layout working for the people who read the reports each morning?",
  "We released a small update to filters last week, so let me show you where it lives.",
  "New team members get access through the invite page in settings.",
  "The help centre has a good article on sharing views.",
  "How has the team found the new folder structure since you reorganised it?",
  "I'd suggest we keep this call monthly, unless you'd prefer a different rhythm.",
  "Let's take a quick look at which reports are opened most often.",
  "That workflow looks sensible, and it's similar to how other operations teams do it.",
  "A sandbox view lets analysts try changes without affecting anyone.",
  "Thanks, that's really helpful context for me.",
  "Shall we spend the last few minutes on questions from the wider team?",
  "Our product team publishes release notes in the help centre each month.",
  "Good, then I think we have everything we need for today.",
];

const CUSTOMER_LINES = [
  "Thanks for setting this up, the timing works well for us this week.",
  "Most of the team opens the morning dashboard before the daily stand-up.",
  "We added a few people from the regional office, so they're still finding their way around.",
  "The shared views have saved us some back and forth on email.",
  "I'd like to understand how the filters work when we combine several sites.",
  "Our analysts mostly work in the detailed tables and export into their own models.",
  "We changed how we name the folders, which made things easier to find.",
  "Can you remind me where the setting for default date ranges is?",
  "The new starters found the training video useful last month.",
  "We're planning to bring the planning team into the workspace next quarter.",
  "I think the weekly summary is the view people rely on the most.",
  "It would help to have a short checklist for setting up a new site.",
  "We had a question about permissions for read-only users.",
  "Our operations lead wants to see the same view on her tablet in the warehouse.",
  "The alert for late shipments is the one we look at first every day.",
  "The team keeps a list of new people in our shared drive.",
  "We're happy with how the dashboards look after the clean-up.",
  "Could we get a copy of the slides from the training session?",
  "The analysts asked whether they can schedule a view to go to a shared mailbox.",
  "We're still deciding how to organise reports by region versus by product line.",
  "That makes sense to me.",
  "Our IT colleague manages the access settings on our side.",
  "The morning routine works well now that everyone uses the same view.",
  "I don't have anything else from my side, this was a useful session.",
];

export const TRANSCRIPTS: TranscriptSpec[] = [
  {
    file: "brightwell-2026-10-21.txt",
    account: "brightwell",
    title: "Brightwell Logistics — monthly check-in",
    date: "2026-10-21",
    csm: "Leo Marsh",
    customer: ["Lena Brooks", "Ben Okafor", "Tariq Haddad"],
    seeded: true,
    planted: [
      { speaker: "Ben Okafor", line: "Our CFO asked us to look at Tallyfield before renewal." },
      {
        speaker: "Tariq Haddad",
        line: "Honestly the scheduled reports have been flaky since September.",
      },
    ],
  },
  {
    file: "brightwell-2026-11-02.txt",
    account: "brightwell",
    title: "Brightwell Logistics — sync with finance",
    date: "2026-11-02",
    csm: "Leo Marsh",
    customer: ["Ben Okafor", "Lena Brooks"],
    seeded: false,
    planted: [
      {
        speaker: "Lena Brooks",
        line: "Ben will own the rollout from finance now that Maya has left.",
      },
      { speaker: "Ben Okafor", line: "Can you send the usage numbers by Friday?" },
      {
        speaker: "Leo Marsh",
        line: "We'll fix the scheduled report failures and confirm by November 13.",
      },
    ],
  },
  {
    file: "halden-2026-10-02.txt",
    account: "halden",
    title: "Halden Retail — export follow-up",
    date: "2026-10-02",
    csm: "Leo Marsh",
    customer: ["Elena Voss", "Marcus Hill"],
    seeded: true,
    planted: [
      {
        speaker: "Leo Marsh",
        line: "Engineering will have the CSV export fix to you by October 24.",
      },
    ],
  },
  {
    file: "northgate-2026-10-15.txt",
    account: "northgate",
    title: "Northgate Freight — quarterly review",
    date: "2026-10-15",
    csm: "Leo Marsh",
    customer: ["Sam Reyes", "Dora Lindqvist"],
    seeded: true,
    planted: [
      {
        speaker: "Dora Lindqvist",
        line: "We need to see the API limits fixed before we sign again.",
      },
      {
        speaker: "Dora Lindqvist",
        line: "Budget is tight next year, so every tool is being reviewed.",
      },
    ],
  },
  {
    file: "copperleaf-2026-10-19.txt",
    account: "copperleaf",
    title: "Copperleaf Studios — team rollout",
    date: "2026-10-19",
    csm: "Aisha Bello",
    customer: ["Iris Tan", "Felix Moreau"],
    seeded: true,
    planted: [{ speaker: "Felix Moreau", line: "We want every studio lead on Larkspur by Q1." }],
  },
  {
    file: "marlow-finch-2026-10-08.txt",
    account: "marlow-finch",
    title: "Marlow & Finch — month-end reporting",
    date: "2026-10-08",
    csm: "Leo Marsh",
    customer: ["Hugo Marlow", "Anya Finch"],
    seeded: true,
    planted: [{ speaker: "Anya Finch", line: "Our goal is to cut month-end close to 3 days." }],
  },
  ...(
    [
      [
        "tidewater",
        "Tidewater Clinics — monthly check-in",
        "2026-10-12",
        "Leo Marsh",
        ["Nora Blake", "Carla Diaz"],
      ],
      [
        "ashgrove",
        "Ashgrove Manufacturing — after the migration",
        "2026-09-28",
        "Aisha Bello",
        ["Victor Kim", "Hana Sato"],
      ],
      ["quillmark", "Quillmark Legal — check-in", "2026-09-10", "Aisha Bello", ["Grace Lin"]],
      [
        "pinecrest",
        "Pinecrest Health — onboarding kickoff",
        "2026-10-01",
        "Aisha Bello",
        ["Mei Chen", "Will Grant"],
      ],
      ["glenmore", "Glenmore Foods — check-in", "2026-08-31", "Aisha Bello", ["Olive Grant"]],
      [
        "silverline",
        "Silverline Couriers — dispatch reporting",
        "2026-10-06",
        "Leo Marsh",
        ["Ken Ward", "Amy Stone"],
      ],
      [
        "kestrel",
        "Kestrel Robotics — workspace review",
        "2026-10-20",
        "Leo Marsh",
        ["Ola Nilsen", "Bea Laurent"],
      ],
      [
        "fairhaven",
        "Fairhaven Dental Group — check-in",
        "2026-10-14",
        "Aisha Bello",
        ["Sofia Russo"],
      ],
    ] as const
  ).map(([account, title, date, csm, customer]): TranscriptSpec => ({
    file: `${account}-${date}.txt`,
    account,
    title,
    date,
    csm,
    customer: [...customer],
    planted: [],
    seeded: true,
  })),
];

export function composeTranscript(spec: TranscriptSpec): string {
  const rng = createRng(
    spec.file.split("").reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7),
  );
  const turns: string[] = [];
  const words = () => turns.join(" ").split(/\s+/).length;
  const target = 1300 + rng.int(0, 900);
  const plantAt = spec.planted.map((_, i) =>
    Math.round(((i + 1) * 100) / (spec.planted.length + 1)),
  );
  let n = 0;
  while (words() < target) {
    const csmTurn = n % 2 === 0;
    const speaker = csmTurn ? spec.csm : rng.pick(spec.customer);
    const bank = csmTurn ? CSM_LINES : CUSTOMER_LINES;
    turns.push(`${speaker}: ${rng.pick(bank)} ${rng.pick(bank)}`);
    n++;
  }
  // Insert planted lines (verbatim) at fixed relative positions, each as its own turn.
  spec.planted.forEach((p, i) => {
    const at = Math.min(turns.length, Math.round((plantAt[i]! / 100) * turns.length) + i);
    turns.splice(at, 0, `${p.speaker}: ${p.line}`);
  });
  const header = [
    `Title: ${spec.title}`,
    `Date: ${spec.date}`,
    `Participants: ${spec.csm} (Larkspur Analytics), ${spec.customer.join(", ")}`,
    "Fictional seed transcript — demo data only.",
    "",
  ];
  return [...header, ...turns].join("\n") + "\n";
}

if (process.argv[1]?.endsWith("make-transcripts.ts")) {
  const dir = path.join(import.meta.dirname, "transcripts");
  mkdirSync(dir, { recursive: true });
  for (const t of TRANSCRIPTS) writeFileSync(path.join(dir, t.file), composeTranscript(t));
  console.log(`wrote ${TRANSCRIPTS.length} transcripts to ${path.relative(process.cwd(), dir)}`);
}
