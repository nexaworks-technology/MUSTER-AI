/**
 * Muster Demo story data (docs/DEMO-WALKTHROUGH.md): fictional accounts, people and the shape of
 * their raw records. Every value here is a RAW INPUT (what a CRM, billing system, product analytics,
 * help desk or mailbox would hold). Nothing here is a health score, a signal, an approval or AI text:
 * those are computed afterwards by the product's own pipelines (scripts/demo-workspace.ts).
 * All domains are .test; all dates are days relative to the day the script runs.
 */
export type OwnerKey = "jonah" | "marcus" | null;
export type StakeholderRole =
  "CHAMPION" | "DECISION_MAKER" | "DAILY_USER" | "EXEC_SPONSOR" | "BILLING" | "OTHER";
export type Stage = "ONBOARDING" | "ADOPTING" | "MATURE" | "RENEWING" | "LOST";

export interface PersonSpec {
  key: string;
  name: string;
  title: string;
  roles?: Array<{ role: StakeholderRole; fromDaysAgo: number }>;
  /** Overrides first.last@domain (e.g. a team subdomain). */
  email?: string;
  status?: "ACTIVE" | "BOUNCED" | "LEFT";
  statusDaysAgo?: number;
  /** Days ago this person first used the product (default: before the usage history). */
  firstActiveDaysAgo?: number;
  /** Days ago this person stopped using the product. */
  lastActiveDaysAgo?: number;
}

export interface AccountSpec {
  key: string;
  name: string;
  domain: string;
  owner: OwnerKey;
  plan: "Starter" | "Growth" | "Scale" | "Enterprise";
  industry: string;
  employeeBand: "1-50" | "51-200" | "201-1000" | "1000+";
  stage: Stage;
  /** Annual contract value in USD. */
  arrUsd: number;
  seats: number;
  /** Days from today to the renewal date (negative = already passed). */
  renewalInDays: number;
  noticePeriodDays: 30 | 60 | 90;
  onboardingDay?: number;
  churnedDaysAgo?: number;
  people: PersonSpec[];
  /** Active users on a weekday `d` days ago (before the weekend factor). */
  users: (d: number) => number;
  /** A CSM Pulse: the owner's own read of the account (a person's input, not a computed value). */
  pulse?: { by: "jonah" | "marcus"; value: "FINE" | "WORRIED"; daysAgo: number; comment: string };
  /** In a decline, the heaviest users are the first to stop (power users go quiet). */
  powerUsersQuit?: boolean;
  /** Key features nobody has used in the last 30 days. */
  stoppedFeatures?: string[];
  /** A mid-term seat upgrade: the earlier contract (seats, value) ended this many days ago. */
  upgradedDaysAgo?: number;
  priorSeats?: number;
  priorArrUsd?: number;
  /** Long tail: the newest monthly invoice failed. */
  failedInvoice?: boolean;
  /** What this account demonstrates (the story map). */
  story?: string;
  storyNo?: number;
}

const ramp = (d: number, from: number, to: number, startDaysAgo: number, endDaysAgo = 0) =>
  d >= startDaysAgo
    ? from
    : d <= endDaysAgo
      ? to
      : from + ((to - from) * (startDaysAgo - d)) / (startDaysAgo - endDaysAgo);

const p = (
  key: string,
  name: string,
  title: string,
  role?: StakeholderRole,
  extra: Partial<PersonSpec> = {},
): PersonSpec => ({
  key,
  name,
  title,
  roles: role ? [{ role, fromDaysAgo: 400 }] : [],
  ...extra,
});

export const STORY: AccountSpec[] = [
  {
    storyNo: 1,
    key: "halvorsen",
    name: "Halvorsen Freight",
    domain: "halvorsen-freight.test",
    owner: "jonah",
    plan: "Enterprise",
    industry: "Logistics",
    employeeBand: "1000+",
    stage: "MATURE",
    arrUsd: 148_000,
    seats: 80,
    renewalInDays: 75,
    noticePeriodDays: 60,
    story:
      "At Risk: champion Priyanka Nair left (former employee, email bounced) and usage is falling. Health reasons, the Champion Loss save play and a check-in approval waiting.",
    people: [
      p("priyanka", "Priyanka Nair", "Former employee", "CHAMPION", {
        status: "LEFT",
        statusDaysAgo: 8,
        lastActiveDaysAgo: 12,
      }),
      p("oskar", "Oskar Lund", "VP Operations", "EXEC_SPONSOR"),
      p("delia", "Delia Marsh", "Director of Finance", "DECISION_MAKER"),
      p("ravi", "Ravi Chandra", "Fleet Planner", "DAILY_USER"),
      p("ellen", "Ellen Moss", "Reporting Analyst", "DAILY_USER"),
    ],
    users: (d) => ramp(d, 62, 9, 40),
    powerUsersQuit: true,
    stoppedFeatures: ["scheduled_reports", "alerts"],
    pulse: {
      by: "jonah",
      value: "WORRIED",
      daysAgo: 2,
      comment: "Champion gone, usage more than halved, renewal in under three months",
    },
  },
  {
    storyNo: 2,
    key: "brambleway",
    name: "Brambleway Health",
    domain: "brambleway-health.test",
    owner: "marcus",
    plan: "Growth",
    industry: "Healthcare",
    employeeBand: "201-1000",
    stage: "MATURE",
    arrUsd: 44_000,
    seats: 50,
    renewalInDays: 150,
    noticePeriodDays: 60,
    story:
      "At Risk: a spike of support tickets including a written complaint, so approvals on this account are SENSITIVE (never auto-sent, never decided from Slack).",
    people: [
      p("hana", "Hana Okoye", "Clinical Operations Lead", "CHAMPION"),
      p("gil", "Gil Ferreira", "Head of IT", "DECISION_MAKER"),
      p("tess", "Tess Albright", "Data Coordinator", "DAILY_USER"),
    ],
    users: (d) => ramp(d, 34, 9, 45, 5),
    powerUsersQuit: true,
    stoppedFeatures: ["alerts", "scheduled_reports"],
    pulse: {
      by: "marcus",
      value: "WORRIED",
      daysAgo: 1,
      comment: "Hana is upset about the outages; they are raising tickets instead of talking to us",
    },
  },
  {
    storyNo: 3,
    key: "corvid",
    name: "Corvid Analytics",
    domain: "corvid-analytics.test",
    owner: "jonah",
    plan: "Growth",
    industry: "Market research",
    employeeBand: "51-200",
    stage: "RENEWING",
    arrUsd: 46_000,
    seats: 52,
    renewalInDays: 28,
    noticePeriodDays: 30,
    story: "Watch: seats in use falling over 90 days, renewal due in 28 days.",
    people: [
      p("mila", "Mila Novak", "Research Director", "CHAMPION"),
      p("teo", "Teo Barros", "COO", "DECISION_MAKER"),
      p("ana", "Ana Kristensen", "Analyst", "DAILY_USER"),
    ],
    users: (d) => ramp(d, 46, 18, 90),
    powerUsersQuit: true,
    pulse: {
      by: "jonah",
      value: "WORRIED",
      daysAgo: 4,
      comment: "Seats keep dropping ahead of the renewal; they may cut the seat count",
    },
  },
  {
    storyNo: 4,
    key: "lindqvist",
    name: "Lindqvist Robotics",
    domain: "lindqvist-robotics.test",
    owner: "marcus",
    plan: "Scale",
    industry: "Manufacturing",
    employeeBand: "201-1000",
    stage: "MATURE",
    arrUsd: 120_000,
    seats: 100,
    renewalInDays: 210,
    noticePeriodDays: 60,
    story:
      "Healthy with an expansion signal: seats near the limit and a second department (Research) starting to use the product. Expansion approval waiting; expansion amount in Revenue.",
    people: [
      p("sofia", "Sofia Lindqvist", "Head of Production Analytics", "CHAMPION"),
      p("arne", "Arne Dahl", "CFO", "DECISION_MAKER"),
      p("kai", "Kai Brenner", "Plant Engineer", "DAILY_USER"),
      // The Research team: new people on their own email subdomain in the last three weeks.
      ...[
        ["rina", "Rina Halsey", "Research Scientist"],
        ["omar", "Omar Saleh", "Research Engineer"],
        ["lise", "Lise Ekdahl", "Research Lead"],
        ["ben", "Ben Torvik", "Lab Analyst"],
        ["yuki", "Yuki Morita", "Research Scientist"],
        ["paul", "Paul Graves", "Research Engineer"],
        ["ines", "Ines Duarte", "Lab Analyst"],
        ["felix", "Felix Aho", "Research Scientist"],
        ["nora", "Nora Lind", "Research Engineer"],
        ["sami", "Sami Virtanen", "Lab Analyst"],
      ].map(([key, name, title], i) =>
        p(key!, name!, title!, undefined, {
          email: `${name!.toLowerCase().replace(" ", ".")}@research.lindqvist-robotics.test`,
          firstActiveDaysAgo: 18 - i,
        }),
      ),
    ],
    users: (d) => 96 + (d < 18 ? Math.min(10, 18 - d) : 0),
    upgradedDaysAgo: 60,
    priorSeats: 80,
    priorArrUsd: 96_000,
  },
  {
    storyNo: 5,
    key: "tamsin",
    name: "Tamsin Bio",
    domain: "tamsin-bio.test",
    owner: "jonah",
    plan: "Growth",
    industry: "Biotech",
    employeeBand: "51-200",
    stage: "ONBOARDING",
    arrUsd: 36_000,
    seats: 40,
    renewalInDays: 333,
    noticePeriodDays: 30,
    onboardingDay: 32,
    story:
      "Mid-onboarding: kickoff and admin guide done, data connection in progress, SSO setup (customer step) overdue.",
    people: [
      p("leah", "Leah Brandt", "Lab Operations Manager", "CHAMPION"),
      p("viktor", "Viktor Sand", "IT Manager", "DAILY_USER"),
      p("carmen", "Carmen Ruiz", "VP Research", "DECISION_MAKER"),
    ],
    users: (d) => (d >= 30 ? 0 : Math.min(16, (30 - d) * 0.7)),
  },
  {
    storyNo: 6,
    key: "quarry-lane",
    name: "Quarry Lane Media",
    domain: "quarry-lane.test",
    owner: "marcus",
    plan: "Growth",
    industry: "Media",
    employeeBand: "51-200",
    stage: "RENEWING",
    arrUsd: 30_000,
    seats: 34,
    renewalInDays: -12,
    noticePeriodDays: 30,
    story:
      "Renewal overdue with total silence: the renewal date passed 12 days ago and there has been no email, meeting or product activity for about six weeks.",
    people: [
      p("dmitri", "Dmitri Volkov", "Head of Content", "CHAMPION"),
      p("jules", "Jules Martin", "Managing Director", "DECISION_MAKER"),
    ],
    users: (d) => (d > 44 ? 21 : 0),
  },
  {
    storyNo: 7,
    key: "orchid-vale",
    name: "Orchid & Vale Partners",
    domain: "orchid-vale.test",
    owner: "jonah",
    plan: "Scale",
    industry: "Professional services",
    employeeBand: "201-1000",
    stage: "MATURE",
    arrUsd: 96_000,
    seats: 100,
    renewalInDays: 120,
    noticePeriodDays: 60,
    story:
      "Healthy and QBR-ready: a past check-in with notes, a QBR next week, a generated QBR draft and a pre-call brief; success plan shared to the customer portal.",
    people: [
      p("imogen", "Imogen Vale", "Finance Director", "CHAMPION"),
      p("rupert", "Rupert Orchid", "Managing Partner", "EXEC_SPONSOR"),
      p("selma", "Selma Quist", "Controller", "DECISION_MAKER"),
      p("aled", "Aled Price", "Senior Accountant", "DAILY_USER"),
    ],
    users: () => 74,
  },
  {
    storyNo: 8,
    key: "saltire",
    name: "Saltire Payments",
    domain: "saltire-payments.test",
    owner: "marcus",
    plan: "Growth",
    industry: "Fintech",
    employeeBand: "51-200",
    stage: "MATURE",
    arrUsd: 48_000,
    seats: 56,
    renewalInDays: 95,
    noticePeriodDays: 60,
    story:
      "Billing risk: a failed-payment invoice beside paid and open ones; two subscriptions on different plans and quantities.",
    people: [
      p("callum", "Callum Reid", "Head of Risk", "CHAMPION"),
      p("freya", "Freya Ross", "Finance Manager", "BILLING"),
      p("niamh", "Niamh Kerr", "CEO", "DECISION_MAKER"),
    ],
    users: () => 40,
  },
  {
    storyNo: 9,
    key: "fenwick",
    name: "Fenwick Learning",
    domain: "fenwick-learning.test",
    owner: "jonah",
    plan: "Growth",
    industry: "Education",
    employeeBand: "51-200",
    stage: "MATURE",
    arrUsd: 38_000,
    seats: 44,
    renewalInDays: 60,
    noticePeriodDays: 60,
    story:
      "Survey risk: an NPS detractor and a low CSAT; promoter responses sit on other accounts for contrast.",
    people: [
      p("priscilla", "Priscilla Hart", "Director of Programs", "CHAMPION"),
      p("magnus", "Magnus Berg", "Head of Finance", "DECISION_MAKER"),
      p("zoe", "Zoe Clarke", "Program Coordinator", "DAILY_USER"),
    ],
    users: () => 31,
  },
  {
    storyNo: 10,
    key: "pellucid",
    name: "Pellucid Studio",
    domain: "pellucid-studio.test",
    owner: "marcus",
    plan: "Growth",
    industry: "Design",
    employeeBand: "51-200",
    stage: "LOST",
    arrUsd: 28_000,
    seats: 30,
    renewalInDays: -40,
    noticePeriodDays: 30,
    churnedDaysAgo: 40,
    story: "A lost account: churned 40 days ago, shown as Lost and not scored.",
    people: [p("ottilie", "Ottilie Grant", "Studio Manager", "CHAMPION")],
    users: (d) => (d <= 40 ? 0 : ramp(d, 22, 6, 110, 41)),
  },
  {
    storyNo: 11,
    key: "ashby-mercer",
    name: "Ashby Mercer Logistics",
    domain: "ashby-mercer.test",
    owner: "marcus",
    plan: "Growth",
    industry: "Logistics",
    employeeBand: "201-1000",
    stage: "MATURE",
    arrUsd: 34_000,
    seats: 40,
    renewalInDays: 260,
    noticePeriodDays: 60,
    story:
      "Data-quality conflict: HubSpot and Salesforce disagree on industry and employee band, so a CONFLICT issue opens and per-field provenance shows which source set each field.",
    people: [
      p("eamon", "Eamon Ashby", "Operations Director", "CHAMPION"),
      p("rosa", "Rosa Mercer", "CFO", "DECISION_MAKER"),
    ],
    users: () => 26,
  },
];

/** Long tail: small accounts across Healthy, Watch and At Risk (Digital CSM view, portfolio). */
type TailShape = "steady" | "dip" | "collapse";
const TAIL: Array<[string, string, OwnerKey, TailShape, number, number]> = [
  // name, industry, owner, shape, seats, renewalInDays
  ["Aldermoor Dental", "Healthcare", "jonah", "steady", 8, 140],
  ["Birchgate Realty", "Real estate", "jonah", "steady", 6, 210],
  ["Cobblestone Bakery Group", "Food & beverage", null, "steady", 5, 300],
  ["Dunmore Legal", "Legal", "marcus", "dip", 10, 180],
  ["Elmstead Architects", "Architecture", "marcus", "steady", 9, 18],
  ["Foxhollow Vets", "Veterinary", null, "steady", 7, 245],
  ["Glenrock Fitness", "Fitness", "jonah", "collapse", 6, 120],
  ["Harbourline Tours", "Travel", null, "dip", 8, 26],
  ["Ironbridge Engineering", "Engineering", "marcus", "steady", 10, 330],
  ["Juniper Lane Florists", "Retail", null, "steady", 4, 160],
  ["Kingsmere Accountants", "Accounting", "jonah", "steady", 9, 275],
  ["Larchwood Schools", "Education", "marcus", "dip", 10, 200],
  ["Marlowe Print Co", "Printing", null, "collapse", 5, 110],
  ["Netherby Clinics", "Healthcare", "marcus", "steady", 10, 190],
  ["Oakhurst Property", "Real estate", null, "steady", 6, 230],
  ["Penrith Cycles", "Retail", "jonah", "dip", 5, 150],
  ["Quayside Coffee", "Food & beverage", null, "steady", 4, 310],
  ["Redwater Brewing", "Food & beverage", "marcus", "collapse", 7, 135],
  ["Stonebridge Insurance", "Insurance", "marcus", "steady", 10, 260],
  ["Thornfield Recruitment", "Recruitment", "jonah", "steady", 8, 220],
  ["Underwood Events", "Events", null, "dip", 6, 170],
  ["Vantage Signs", "Manufacturing", "marcus", "steady", 5, 285],
  ["Westcliff Hotels", "Hospitality", "jonah", "collapse", 9, 125],
  ["Yarrow Garden Centres", "Retail", null, "steady", 6, 240],
  ["Zephyr Kites", "Retail", "marcus", "dip", 4, 195],
];

const FIRST = ["Alex", "Sam", "Jo", "Robin", "Chris", "Pat", "Jamie", "Morgan", "Kim", "Lee"];
const LAST = ["Hughes", "Patel", "Evans", "Shaw", "Doyle", "Khan", "Price", "Webb", "Lowe", "Hart"];

export const LONG_TAIL: AccountSpec[] = TAIL.map(
  ([name, industry, owner, shape, seats, renewalInDays], i) => {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z ]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    const base = Math.max(2, Math.round(seats * (0.55 + ((i * 7) % 4) * 0.08)));
    return {
      key: `tail-${slug}`,
      name,
      domain: `${slug}.test`,
      owner,
      plan: "Starter" as const,
      industry,
      employeeBand: "1-50" as const,
      stage: "MATURE" as const,
      arrUsd: seats * 840,
      seats,
      renewalInDays,
      noticePeriodDays: 30 as const,
      // Collapsed small accounts: usage stopped and the last card charge failed; at all but
      // Westcliff the one person who used the product has also left.
      failedInvoice: shape === "collapse",
      powerUsersQuit: shape !== "steady",
      people: [
        p(
          "main",
          `${FIRST[i % 10]} ${LAST[(i * 3 + Math.floor(i / 10)) % 10]}`,
          shape === "collapse" && !name.startsWith("Westcliff")
            ? "Former employee"
            : "Office Manager",
          "CHAMPION",
          shape === "collapse" && !name.startsWith("Westcliff")
            ? { status: "LEFT", statusDaysAgo: 18, lastActiveDaysAgo: 30 }
            : {},
        ),
        p("second", `${FIRST[(i + 4) % 10]} ${LAST[(i * 7 + 1) % 10]}`, "Owner", "DECISION_MAKER"),
      ],
      users:
        shape === "steady"
          ? () => base
          : shape === "dip"
            ? (d: number) => ramp(d, base, base * 0.15, 45, 5)
            : (d: number) => ramp(d, base, 0, 50, 20),
    };
  },
);

export const ALL_ACCOUNTS: AccountSpec[] = [...STORY, ...LONG_TAIL];
export const story = (key: string): AccountSpec => {
  const a = STORY.find((x) => x.key === key);
  if (!a) throw new Error(`No story account ${key}`);
  return a;
};
export const emailOf = (a: AccountSpec, person: PersonSpec): string =>
  person.email ??
  `${person.name
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim()
    .replace(/\s+/g, ".")}@${a.domain}`;
