import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Import boundaries that make Rule 2 (tenant isolation) and Rule 3 (approval before
 * customer contact) hold by construction. Each restriction is its own constant so the
 * per-path overrides below can lift exactly one of them and keep the others.
 */
const RAW_DB = {
  group: ["@/lib/db/raw", "**/lib/db/raw"],
  message:
    "The raw Prisma client bypasses workspace scoping. Use scopedDb(ctx) from @/lib/db/scoped (ARCHITECTURE §7.1).",
};
const CUSTOMER_TRANSPORT = {
  group: ["@/lib/email/customerTransport", "**/lib/email/customerTransport"],
  message:
    "Customer email may only be sent through src/modules/outbound/dispatch.ts (ARCHITECTURE §7.4, Rule 3).",
};
const MODULE_INTERNALS = {
  group: ["@/modules/*/*", "!@/modules/*/service", "!@/modules/*/schemas"],
  message: "Modules talk to each other only through their service.ts / schemas.ts exports.",
};
const PRISMA_CLIENT_CTOR = {
  name: "@prisma/client",
  importNames: ["PrismaClient"],
  message: "Construct Prisma clients only in src/lib/db.",
};

const restricted = (patterns, paths = [PRISMA_CLIENT_CTOR]) => ({
  "no-restricted-imports": ["error", { patterns, paths }],
});

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
    // Deliberately-violating files used by the lint-rule tests; linted only by those tests.
    "**/__tests__/lint-fixtures/**",
  ]),
  {
    rules: {
      ...restricted([RAW_DB, CUSTOMER_TRANSPORT, MODULE_INTERNALS]),
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Allowed users of the raw client: the db layer itself, global identity tables (auth),
    // the seed, and the outbox dispatcher (it re-scopes per event payload).
    files: [
      "src/lib/db/**",
      "src/lib/auth/**",
      "prisma/**",
      "src/lib/jobs/outbox.ts",
      "scripts/**",
    ],
    rules: restricted([CUSTOMER_TRANSPORT, MODULE_INTERNALS], []),
  },
  {
    // The single customer-send choke point (arrives in M4).
    files: ["src/modules/outbound/dispatch.ts"],
    rules: restricted([RAW_DB, MODULE_INTERNALS]),
  },
]);
