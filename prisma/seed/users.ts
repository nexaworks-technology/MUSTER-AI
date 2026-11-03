/**
 * Seed users (docs/SEED_DATA.md §2). DEV-ONLY credentials: the seed refuses to run in
 * production, and these accounts exist only in local, test and demo databases.
 */
export const DEMO_PASSWORD = "larkspur-demo-password";

export const DEMO_WORKSPACE = {
  key: "workspace:larkspur",
  name: "Larkspur Analytics",
  slug: "larkspur-demo",
  timezone: "America/New_York",
  baseCurrency: "USD",
} as const;

export const TEST_TENANT = {
  key: "workspace:ferngrove",
  name: "Ferngrove Software",
  slug: "ferngrove-test",
  timezone: "Europe/London",
  baseCurrency: "GBP",
} as const;

type SeedRole = "ADMIN" | "CS_LEADER" | "CSM" | "VIEWER";

export interface SeedUser {
  key: string;
  name: string;
  email: string;
  role: SeedRole;
  canViewRevenue: boolean;
  bookScope: "OWN" | "TEAM" | "ALL";
}

export const DEMO_USERS: readonly SeedUser[] = [
  {
    key: "user:priya",
    name: "Priya Raman",
    email: "admin@larkspur.test",
    role: "ADMIN",
    canViewRevenue: true,
    bookScope: "ALL",
  },
  {
    key: "user:dana",
    name: "Dana Whitfield",
    email: "dana@larkspur.test",
    role: "CS_LEADER",
    canViewRevenue: true,
    bookScope: "ALL",
  },
  {
    key: "user:leo",
    name: "Leo Marsh",
    email: "leo@larkspur.test",
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  },
  {
    key: "user:aisha",
    name: "Aisha Bello",
    email: "aisha@larkspur.test",
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  },
  {
    key: "user:tom",
    name: "Tom Becker",
    email: "tom@larkspur.test",
    role: "VIEWER",
    canViewRevenue: false,
    bookScope: "ALL",
  },
];

export const TEST_TENANT_USERS: readonly SeedUser[] = [
  {
    key: "user:ferngrove-admin",
    name: "Owen Hale",
    email: "admin@ferngrove.test",
    role: "ADMIN",
    canViewRevenue: true,
    bookScope: "ALL",
  },
];

/** `--empty-workspace` (M5 setup wizard demo): a fresh workspace still in setup, one Admin, no data. */
export const EMPTY_WORKSPACE = {
  key: "workspace:juniper",
  name: "Juniper Labs",
  slug: "juniper-fresh",
  timezone: "America/New_York",
  baseCurrency: "USD",
} as const;

export const EMPTY_WORKSPACE_USERS: readonly SeedUser[] = [
  {
    key: "user:juniper-admin",
    name: "Mara Quinn",
    email: "admin@juniper.test",
    role: "ADMIN",
    canViewRevenue: true,
    bookScope: "ALL",
  },
];
