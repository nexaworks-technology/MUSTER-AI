/**
 * The Larkspur Analytics account roster (docs/SEED_DATA.md §3, §7, §8). Story accounts are
 * hand-authored; the rest are generated deterministically from `createRng()`. Commercial facts
 * (ARR, seats, renewal) live here so every seed section reads one source of truth.
 */
import { createRng } from "./random";

export type Tier = "HIGH_TOUCH" | "MID_TOUCH" | "LONG_TAIL";
export type Owner = "leo" | "aisha" | null;
export type Stage = "ONBOARDING" | "ADOPTING" | "MATURE" | "RENEWING" | "LOST";
export type Role =
  "CHAMPION" | "DECISION_MAKER" | "DAILY_USER" | "EXEC_SPONSOR" | "BILLING" | "OTHER";

export interface ContactSpec {
  key: string;
  name: string;
  title: string;
  status?: "ACTIVE" | "BOUNCED" | "LEFT";
  roles: Array<{ role: Role; fromDaysAgo: number; toDaysAgo?: number }>;
  /** Overrides the default first.last@domain address (used for planted duplicates). */
  email?: string;
}

export interface AccountSpec {
  key: string;
  name: string;
  domain: string;
  tier: Tier;
  owner: Owner;
  stage: Stage;
  plan: "Starter" | "Growth" | "Scale" | "Enterprise";
  industry: string;
  employeeBand: "1-50" | "51-200" | "201-1000" | "1000+";
  /** Annual contract value in USD; null = no contract on file (Fairhaven). */
  arrUsd: number | null;
  seats: number;
  /** Days from SEED_TODAY to renewal; null = contract without a renewal date (Kestrel). */
  renewalInDays: number | null;
  noticePeriodDays: 30 | 60 | 90;
  onboardingDay?: number;
  /** Historical churn (lifecycle LOST): days ago the account churned. */
  churnedDaysAgo?: number;
  /** Renewed in the last 12 months (back-test set): days ago the current contract started. */
  renewedDaysAgo?: number;
  contacts: ContactSpec[];
  story?: string;
}

export const SEAT_PRICE_USD = 900;
const seatsFor = (arr: number) => Math.max(1, Math.round(arr / SEAT_PRICE_USD));

const c = (
  key: string,
  name: string,
  title: string,
  roles: ContactSpec["roles"],
  extra: Partial<ContactSpec> = {},
): ContactSpec => ({
  key,
  name,
  title,
  roles,
  ...extra,
});

/** Hand-authored story accounts (SEED_DATA §3 table, §7 onboarding). */
const STORY: AccountSpec[] = [
  {
    key: "brightwell",
    name: "Brightwell Logistics",
    domain: "brightwell-logistics.test",
    tier: "HIGH_TOUCH",
    owner: "leo",
    stage: "MATURE",
    plan: "Enterprise",
    industry: "Logistics",
    employeeBand: "1000+",
    arrUsd: 186_000,
    seats: seatsFor(186_000),
    renewalInDays: 118,
    noticePeriodDays: 60,
    story: "usage drop, champion Maya Ortiz bounced/left, competitor Tallyfield",
    contacts: [
      c("maya", "Maya Ortiz", "Former employee", [{ role: "CHAMPION", fromDaysAgo: 420 }], {
        status: "BOUNCED",
      }),
      c("ben", "Ben Okafor", "Director of Finance", [{ role: "DECISION_MAKER", fromDaysAgo: 30 }]),
      c("lena", "Lena Brooks", "VP Operations", [{ role: "EXEC_SPONSOR", fromDaysAgo: 400 }]),
      c("tariq", "Tariq Haddad", "Fleet Analyst", [{ role: "DAILY_USER", fromDaysAgo: 380 }]),
      c("june", "June Park", "Reporting Lead", [{ role: "DAILY_USER", fromDaysAgo: 300 }]),
    ],
  },
  {
    key: "northgate",
    name: "Northgate Freight",
    domain: "northgate-freight.test",
    tier: "HIGH_TOUCH",
    owner: "leo",
    stage: "RENEWING",
    plan: "Scale",
    industry: "Logistics",
    employeeBand: "201-1000",
    arrUsd: 142_000,
    seats: seatsFor(142_000),
    renewalInDays: 41,
    noticePeriodDays: 30,
    story: "renewal in 41 days, API limits concern, late invoice",
    contacts: [
      c("sam", "Sam Reyes", "Head of Analytics", [{ role: "CHAMPION", fromDaysAgo: 500 }]),
      c("dora", "Dora Lindqvist", "CFO", [{ role: "DECISION_MAKER", fromDaysAgo: 500 }]),
      c("ivan", "Ivan Petrov", "Data Engineer", [{ role: "DAILY_USER", fromDaysAgo: 300 }]),
    ],
  },
  {
    key: "marlow-finch",
    name: "Marlow & Finch",
    domain: "marlow-finch.test",
    tier: "HIGH_TOUCH",
    owner: "leo",
    stage: "MATURE",
    plan: "Scale",
    industry: "Professional services",
    employeeBand: "201-1000",
    arrUsd: 98_000,
    seats: seatsFor(98_000),
    renewalInDays: 205,
    noticePeriodDays: 60,
    story: "healthy; goal: month-end close in 3 days; QBR due",
    contacts: [
      c("hugo", "Hugo Marlow", "Finance Director", [{ role: "CHAMPION", fromDaysAgo: 600 }]),
      c("anya", "Anya Finch", "Managing Partner", [{ role: "DECISION_MAKER", fromDaysAgo: 600 }]),
      c("rob", "Rob Ellis", "Controller", [{ role: "DAILY_USER", fromDaysAgo: 400 }]),
    ],
  },
  {
    key: "tidewater",
    name: "Tidewater Clinics",
    domain: "tidewater-clinics.test",
    tier: "HIGH_TOUCH",
    owner: "leo",
    stage: "MATURE",
    plan: "Scale",
    industry: "Healthcare",
    employeeBand: "1000+",
    arrUsd: 121_000,
    seats: seatsFor(121_000),
    renewalInDays: 160,
    noticePeriodDays: 90,
    story: "healthy by numbers; Leo is worried (new VP)",
    contacts: [
      c("nora", "Nora Blake", "Operations Manager", [{ role: "CHAMPION", fromDaysAgo: 450 }]),
      c("carla", "Carla Diaz", "VP Clinical Operations", [
        { role: "DECISION_MAKER", fromDaysAgo: 25 },
      ]),
      c(
        "ed",
        "Ed Morton",
        "Former VP Operations",
        [{ role: "DECISION_MAKER", fromDaysAgo: 700, toDaysAgo: 25 }],
        { status: "LEFT" },
      ),
    ],
  },
  {
    key: "pinecrest",
    name: "Pinecrest Health",
    domain: "pinecrest-health.test",
    tier: "MID_TOUCH",
    owner: "aisha",
    stage: "ONBOARDING",
    plan: "Growth",
    industry: "Healthcare",
    employeeBand: "201-1000",
    arrUsd: 28_000,
    seats: 15,
    renewalInDays: 332,
    noticePeriodDays: 60,
    onboardingDay: 33,
    story: "onboarding stalled at SSO setup (customer side, 12 days overdue)",
    contacts: [
      c("mei", "Mei Chen", "Clinical Ops Lead", [{ role: "CHAMPION", fromDaysAgo: 40 }]),
      c("raj", "Raj Patel", "IT Manager", [{ role: "OTHER", fromDaysAgo: 33 }]),
      c("will", "Will Grant", "COO", [{ role: "DECISION_MAKER", fromDaysAgo: 40 }]),
    ],
  },
  {
    key: "copperleaf",
    name: "Copperleaf Studios",
    domain: "copperleaf-studios.test",
    tier: "MID_TOUCH",
    owner: "aisha",
    stage: "ADOPTING",
    plan: "Growth",
    industry: "Media",
    employeeBand: "51-200",
    arrUsd: 36_000,
    seats: 40,
    renewalInDays: 140,
    noticePeriodDays: 30,
    story: "12 seats over limit; new Design team; goal: every studio lead by Q1",
    contacts: [
      c("iris", "Iris Tan", "Studio Operations Lead", [{ role: "CHAMPION", fromDaysAgo: 300 }]),
      c("felix", "Felix Moreau", "Managing Director", [
        { role: "DECISION_MAKER", fromDaysAgo: 300 },
      ]),
      c("dee", "Dee Alvarez", "Design Lead", [{ role: "DAILY_USER", fromDaysAgo: 20 }]),
    ],
  },
  {
    key: "halden",
    name: "Halden Retail",
    domain: "halden-retail.test",
    tier: "MID_TOUCH",
    owner: "leo",
    stage: "MATURE",
    plan: "Growth",
    industry: "Retail",
    employeeBand: "201-1000",
    arrUsd: 44_000,
    seats: seatsFor(44_000),
    renewalInDays: 250,
    noticePeriodDays: 60,
    story: "angry repeat CSV-export problem; promise 'fix by Oct 24' now late",
    contacts: [
      c("elena", "Elena Voss", "Merchandising Ops Manager", [
        { role: "CHAMPION", fromDaysAgo: 500 },
      ]),
      c("marcus", "Marcus Hill", "Head of Retail Ops", [
        { role: "DECISION_MAKER", fromDaysAgo: 500 },
      ]),
    ],
  },
  {
    key: "quillmark",
    name: "Quillmark Legal",
    domain: "quillmark-legal.test",
    tier: "MID_TOUCH",
    owner: "aisha",
    stage: "RENEWING",
    plan: "Growth",
    industry: "Legal",
    employeeBand: "51-200",
    arrUsd: 19_000,
    seats: seatsFor(19_000),
    renewalInDays: 74,
    noticePeriodDays: 30,
    story: "ticket asks how to export all data before cancelling",
    contacts: [
      c("grace", "Grace Lin", "Practice Manager", [{ role: "CHAMPION", fromDaysAgo: 400 }]),
      c("paul", "Paul Adebayo", "Managing Partner", [{ role: "DECISION_MAKER", fromDaysAgo: 400 }]),
    ],
  },
  {
    key: "ashgrove",
    name: "Ashgrove Manufacturing",
    domain: "ashgrove-mfg.test",
    tier: "MID_TOUCH",
    owner: "aisha",
    stage: "MATURE",
    plan: "Growth",
    industry: "Manufacturing",
    employeeBand: "201-1000",
    arrUsd: 22_000,
    seats: seatsFor(22_000),
    renewalInDays: 190,
    noticePeriodDays: 60,
    story: "support spike from one migration (resolved); Aisha says fine",
    contacts: [
      c("victor", "Victor Kim", "Plant Systems Lead", [{ role: "CHAMPION", fromDaysAgo: 350 }]),
      c("hana", "Hana Sato", "Operations Director", [{ role: "DECISION_MAKER", fromDaysAgo: 350 }]),
    ],
  },
  {
    key: "glenmore",
    name: "Glenmore Foods",
    domain: "glenmore-foods.test",
    tier: "MID_TOUCH",
    owner: "aisha",
    stage: "ADOPTING",
    plan: "Growth",
    industry: "Retail",
    employeeBand: "51-200",
    arrUsd: 16_000,
    seats: seatsFor(16_000),
    renewalInDays: 230,
    noticePeriodDays: 30,
    story: "no decision maker known; no meeting in 63 days",
    contacts: [
      c("olive", "Olive Grant", "Supply Planner", [{ role: "CHAMPION", fromDaysAgo: 280 }]),
    ],
  },
  {
    key: "silverline",
    name: "Silverline Couriers",
    domain: "silverline-couriers.test",
    tier: "MID_TOUCH",
    owner: "leo",
    stage: "ADOPTING",
    plan: "Growth",
    industry: "Logistics",
    employeeBand: "51-200",
    arrUsd: 31_000,
    seats: seatsFor(31_000),
    renewalInDays: 270,
    noticePeriodDays: 30,
    story: "data quality: duplicate account + 2 duplicate contacts",
    contacts: [
      c("ken", "Ken Ward", "Dispatch Manager", [{ role: "CHAMPION", fromDaysAgo: 260 }]),
      c("ken-dup", "Ken Ward", "Dispatch Manager", [{ role: "DAILY_USER", fromDaysAgo: 100 }], {
        email: "KEN.WARD@silverline-couriers.test",
      }),
      c("amy", "Amy Stone", "Finance Manager", [{ role: "DECISION_MAKER", fromDaysAgo: 260 }]),
      c("amy-dup", "Amy  Stone", "Finance Mgr", [{ role: "BILLING", fromDaysAgo: 90 }], {
        email: "amy.stone@silverline-couriers.test ",
      }),
    ],
  },
  {
    key: "silverline-inc",
    name: "Silverline Couriers Inc.",
    domain: "silverline-couriers.test",
    tier: "LONG_TAIL",
    owner: null,
    stage: "ADOPTING",
    plan: "Starter",
    industry: "Logistics",
    employeeBand: "51-200",
    arrUsd: 2_700,
    seats: 3,
    renewalInDays: 300,
    noticePeriodDays: 30,
    story: "duplicate of Silverline Couriers (overlapping domain)",
    contacts: [
      c("ken-inc", "Ken Ward", "Dispatch", [{ role: "CHAMPION", fromDaysAgo: 120 }], {
        email: "ken.ward@silverline-couriers.test",
      }),
    ],
  },
  {
    key: "fairhaven",
    name: "Fairhaven Dental Group",
    domain: "fairhaven-dental.test",
    tier: "MID_TOUCH",
    owner: "aisha",
    stage: "ADOPTING",
    plan: "Growth",
    industry: "Healthcare",
    employeeBand: "51-200",
    arrUsd: null,
    seats: 12,
    renewalInDays: null,
    noticePeriodDays: 30,
    story: "no contract on file",
    contacts: [
      c("sofia", "Sofia Russo", "Practice Operations", [{ role: "CHAMPION", fromDaysAgo: 200 }]),
      c("ali", "Ali Khan", "Owner", [{ role: "DECISION_MAKER", fromDaysAgo: 200 }]),
    ],
  },
  {
    key: "kestrel",
    name: "Kestrel Robotics",
    domain: "kestrel-robotics.test",
    tier: "MID_TOUCH",
    owner: "leo",
    stage: "ADOPTING",
    plan: "Growth",
    industry: "Manufacturing",
    employeeBand: "51-200",
    arrUsd: 27_000,
    seats: 30,
    renewalInDays: null,
    noticePeriodDays: 60,
    story: "contract without a renewal date",
    contacts: [
      c("ola", "Ola Nilsen", "Engineering Ops", [{ role: "CHAMPION", fromDaysAgo: 250 }]),
      c("bea", "Bea Laurent", "CTO", [{ role: "DECISION_MAKER", fromDaysAgo: 250 }]),
    ],
  },
  {
    key: "bluefin",
    name: "Bluefin Charters",
    domain: "bluefin-charters.test",
    tier: "MID_TOUCH",
    owner: null,
    stage: "ADOPTING",
    plan: "Growth",
    industry: "Travel",
    employeeBand: "51-200",
    arrUsd: 14_000,
    seats: seatsFor(14_000),
    renewalInDays: 180,
    noticePeriodDays: 30,
    story: "no owner and no key contact",
    contacts: [],
  },
  {
    key: "sundial",
    name: "Sundial Fitness",
    domain: "sundial-fitness.test",
    tier: "LONG_TAIL",
    owner: null,
    stage: "MATURE",
    plan: "Starter",
    industry: "Fitness",
    employeeBand: "1-50",
    arrUsd: 2_400,
    seats: 3,
    renewalInDays: 150,
    noticePeriodDays: 30,
    story: "card payment failed 3 days ago (twice)",
    contacts: [c("jo", "Jo Harper", "Owner", [{ role: "CHAMPION", fromDaysAgo: 500 }])],
  },
  {
    key: "orchard-lane",
    name: "Orchard Lane Bakery Supply",
    domain: "orchard-lane.test",
    tier: "LONG_TAIL",
    owner: null,
    stage: "MATURE",
    plan: "Starter",
    industry: "Food & beverage",
    employeeBand: "1-50",
    arrUsd: 1_800,
    seats: 2,
    renewalInDays: 95,
    noticePeriodDays: 30,
    story: "payment failed yesterday; emailed by a play 2 days ago",
    contacts: [c("pat", "Pat Quinn", "Owner", [{ role: "CHAMPION", fromDaysAgo: 400 }])],
  },
  {
    key: "redfern",
    name: "Redfern Outdoor",
    domain: "redfern-outdoor.test",
    tier: "LONG_TAIL",
    owner: null,
    stage: "ADOPTING",
    plan: "Starter",
    industry: "Retail",
    employeeBand: "1-50",
    arrUsd: 3_600,
    seats: 4,
    renewalInDays: 210,
    noticePeriodDays: 30,
    story: "no logins in 24 days; secondary contact unsubscribed",
    contacts: [
      c("cal", "Cal Mercer", "Store Manager", [{ role: "CHAMPION", fromDaysAgo: 300 }]),
      c("rhea", "Rhea Mercer", "Bookkeeper", [{ role: "BILLING", fromDaysAgo: 300 }]),
    ],
  },
  // Onboarding (SEED_DATA §7) — Pinecrest is above.
  ...(
    [
      ["wrenfield", "Wrenfield Labs", "MID_TOUCH", "aisha", 12, 24_000, "Biotech"],
      ["ostara", "Ostara Home Goods", "MID_TOUCH", "aisha", 47, 18_000, "Retail"],
      ["cobalt-ridge", "Cobalt Ridge Transit", "MID_TOUCH", "leo", 20, 33_000, "Logistics"],
      ["juniper-vet", "Juniper Vet Partners", "MID_TOUCH", "aisha", 61, 21_000, "Healthcare"],
      ["lumen", "Lumen Freightworks", "HIGH_TOUCH", "leo", 75, 64_000, "Logistics"],
      ["saltmarsh", "Saltmarsh Media", "MID_TOUCH", "aisha", 5, 15_000, "Media"],
      ["ridgeback", "Ridgeback Security", "MID_TOUCH", "aisha", 28, 26_000, "Security"],
    ] as const
  ).map(([key, name, tier, owner, day, arr, industry]): AccountSpec => ({
    key,
    name,
    domain: `${key}.test`,
    tier,
    owner,
    stage: "ONBOARDING",
    plan: tier === "HIGH_TOUCH" ? "Scale" : "Growth",
    industry,
    employeeBand: tier === "HIGH_TOUCH" ? "201-1000" : "51-200",
    arrUsd: arr,
    seats: seatsFor(arr),
    renewalInDays: 365 - day,
    noticePeriodDays: 30,
    onboardingDay: day,
    story: `onboarding day ${day}`,
    contacts: [],
  })),
];

const COMPANY_A = [
  "Harbor",
  "Stone",
  "Maple",
  "Cedar",
  "Summit",
  "River",
  "Beacon",
  "Granite",
  "Willow",
  "Falcon",
  "Aspen",
  "Meridian",
  "Oak",
  "Lark",
  "Hollow",
  "Crescent",
  "Juniper",
  "Atlas",
  "Pioneer",
  "Evergreen",
  "Bright",
  "Clear",
  "North",
  "Sterling",
  "Prairie",
  "Coastal",
  "Iron",
  "Silver",
  "Golden",
  "Blue",
];
const COMPANY_B = [
  "view",
  "bridge",
  "field",
  "crest",
  "wood",
  "point",
  "gate",
  "stone",
  "brook",
  "ridge",
  "haven",
  "dale",
  "line",
  "way",
  "mark",
];
const COMPANY_C: Record<string, string[]> = {
  Logistics: ["Logistics", "Freight", "Couriers", "Transport"],
  Retail: ["Retail", "Stores", "Outfitters", "Market"],
  Healthcare: ["Health", "Clinics", "Care Partners", "Medical"],
  "Professional services": ["Advisory", "Partners", "Consulting", "Accounting"],
  Fitness: ["Fitness", "Athletics", "Studios"],
  Legal: ["Legal", "Law Group", "Solicitors"],
  Manufacturing: ["Manufacturing", "Industries", "Works", "Fabrication"],
};
const INDUSTRIES = Object.keys(COMPANY_C);
const FIRST = [
  "Alex",
  "Jordan",
  "Taylor",
  "Morgan",
  "Casey",
  "Riley",
  "Jamie",
  "Avery",
  "Quinn",
  "Drew",
  "Robin",
  "Sasha",
  "Noah",
  "Emma",
  "Liam",
  "Olivia",
  "Mateo",
  "Priyanka",
  "Kofi",
  "Ines",
  "Yuki",
  "Omar",
  "Leila",
  "Tomas",
  "Freya",
  "Diego",
  "Amara",
  "Lucas",
  "Zara",
  "Henrik",
];
const LAST = [
  "Fischer",
  "Okoye",
  "Silva",
  "Novak",
  "Larsen",
  "Murphy",
  "Rossi",
  "Kowalski",
  "Nguyen",
  "Duarte",
  "Haddad",
  "Becker",
  "Mensah",
  "Sato",
  "Ibarra",
  "Walsh",
  "Lund",
  "Costa",
  "Byrne",
  "Reddy",
];
const TITLES = [
  "Operations Manager",
  "Analytics Lead",
  "Head of Operations",
  "Finance Manager",
  "Data Analyst",
  "COO",
  "IT Lead",
  "Team Lead",
];

function generated(): AccountSpec[] {
  const rng = createRng(20261102);
  const used = new Set(STORY.map((s) => s.name));
  const name = (industry: string) => {
    for (;;) {
      const n = `${rng.pick(COMPANY_A)}${rng.pick(COMPANY_B)} ${rng.pick(COMPANY_C[industry]!)}`;
      if (!used.has(n)) {
        used.add(n);
        return n;
      }
    }
  };
  const people = (
    domain: string,
    key: string,
    tier: Tier,
    withDecisionMaker = true,
  ): ContactSpec[] => {
    const count =
      tier === "HIGH_TOUCH" ? rng.int(3, 9) : tier === "MID_TOUCH" ? rng.int(2, 5) : rng.int(1, 2);
    return Array.from({ length: count }, (_, i) => {
      const role: Role =
        i === 0
          ? "CHAMPION"
          : i === 1 && withDecisionMaker && tier !== "LONG_TAIL"
            ? "DECISION_MAKER"
            : rng.pick(["DAILY_USER", "DAILY_USER", "EXEC_SPONSOR", "BILLING"] as const);
      return c(`${key}-p${i}`, `${rng.pick(FIRST)} ${rng.pick(LAST)}`, rng.pick(TITLES), [
        { role, fromDaysAgo: rng.int(120, 700) },
      ]);
    });
  };
  const spec = (
    i: number,
    tier: Tier,
    owner: Owner,
    arr: number,
    extra: Partial<AccountSpec>,
  ): AccountSpec => {
    const industry = rng.pick(INDUSTRIES);
    const n = name(industry);
    const key = `gen-${i}`;
    const domain = `${n
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")}.test`;
    return {
      key,
      name: n,
      domain,
      tier,
      owner,
      stage: "MATURE",
      industry,
      plan:
        tier === "HIGH_TOUCH"
          ? arr > 150_000
            ? "Enterprise"
            : "Scale"
          : tier === "MID_TOUCH"
            ? "Growth"
            : "Starter",
      employeeBand:
        tier === "HIGH_TOUCH"
          ? rng.pick(["201-1000", "1000+"] as const)
          : tier === "MID_TOUCH"
            ? rng.pick(["51-200", "201-1000"] as const)
            : rng.pick(["1-50", "51-200"] as const),
      arrUsd: arr,
      seats: seatsFor(arr),
      renewalInDays: 0,
      noticePeriodDays: rng.pick([30, 60, 90] as const),
      contacts: people(domain, key, tier),
      ...extra,
    };
  };

  const active: AccountSpec[] = [];
  // 10 high-touch in total: 4 story + Lumen + 5 generated, all Leo's.
  for (let i = 0; i < 5; i++)
    active.push(spec(active.length, "HIGH_TOUCH", "leo", rng.int(55, 240) * 1000, {}));
  // 20 mid-touch in total: 16 story/onboarding + 4 generated (Leo 2, Aisha 2). Bluefin has no owner.
  for (let i = 0; i < 4; i++)
    active.push(
      spec(active.length, "MID_TOUCH", i < 2 ? "leo" : "aisha", rng.int(12, 48) * 1000, {}),
    );
  // 30 long-tail in total: 4 story (incl. the Silverline duplicate) + 26 generated, no owner.
  for (let i = 0; i < 26; i++)
    active.push(spec(active.length, "LONG_TAIL", null, rng.int(12, 96) * 100, {}));

  // Renewal dates spread over the next 12 months (~5 per month), shuffled across tiers.
  const order = active.map((_, i) => i).sort(() => rng.next() - 0.5);
  order.forEach((idx, rank) => {
    active[idx]!.renewalInDays = 9 + Math.round((rank * 350) / order.length);
  });
  // 12 of them renewed 1–11 months ago (SEED_DATA §8): their current contract started then.
  active
    .filter((a) => a.renewalInDays! > 30 && a.renewalInDays! < 335)
    .slice(0, 12)
    .forEach((a, i) => {
      a.renewedDaysAgo = 365 - a.renewalInDays!;
      a.story =
        i < 2 ? "renewed; had a temporary dip (false-alarm case)" : "renewed in the last 12 months";
    });

  // 12 churned accounts (lifecycle LOST), churned 1–14 months ago; 3 are silent churns.
  const churned: AccountSpec[] = Array.from({ length: 12 }, (_, i) => {
    const tier: Tier = i < 3 ? "HIGH_TOUCH" : i < 8 ? "MID_TOUCH" : "LONG_TAIL";
    const arr =
      tier === "HIGH_TOUCH"
        ? rng.int(55, 120) * 1000
        : tier === "MID_TOUCH"
          ? rng.int(12, 40) * 1000
          : rng.int(12, 90) * 100;
    const pattern = [
      "usage drop",
      "usage drop",
      "usage drop",
      "usage drop",
      "champion left",
      "champion left",
      "payment failures",
      "support escalation",
      "support escalation",
      "silent",
      "silent",
      "silent",
    ][i]!;
    return spec(100 + i, tier, tier === "LONG_TAIL" ? null : i % 2 === 0 ? "leo" : "aisha", arr, {
      key: `churned-${i}`,
      stage: "LOST",
      churnedDaysAgo: 30 + i * 35,
      renewalInDays: -(30 + i * 35),
      story: `churned (${pattern})`,
    });
  });
  return [...active, ...churned];
}

export const ROSTER: readonly AccountSpec[] = [...STORY, ...generated()].map((a) => {
  // Accounts renewing within 90 days are in the RENEWING stage (unless onboarding or lost).
  if (
    a.stage === "MATURE" &&
    a.renewalInDays !== null &&
    a.renewalInDays >= 0 &&
    a.renewalInDays <= 90
  ) {
    return { ...a, stage: "RENEWING" };
  }
  return a;
});

export const activeAccounts = () => ROSTER.filter((a) => a.stage !== "LOST");
export const accountByKey = (key: string) => {
  const found = ROSTER.find((a) => a.key === key);
  if (!found) throw new Error(`Unknown seed account ${key}`);
  return found;
};
