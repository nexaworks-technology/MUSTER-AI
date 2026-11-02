import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Files that re-seed or read the shared demo workspace run after everything else, one file at a
 * time (D-68): a reader must never see another file's re-seed half-done. Every other test owns
 * its own workspace and runs in parallel.
 */
const DEMO_SEED_FILES = [
  "prisma/seed/**/*.int.test.ts",
  "src/modules/health/__tests__/backtest-seed.int.test.ts",
];

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    exclude: ["**/node_modules/**", "**/lint-fixtures/**"],
    environment: "node",
    // next-auth imports "next/server" without an extension; let Vite resolve it like Next does.
    server: { deps: { inline: ["next-auth"] } },
    testTimeout: 30_000,
    globalSetup: ["src/test/global-setup.ts"],
    setupFiles: ["src/test/setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "app",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "prisma/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/lint-fixtures/**", ...DEMO_SEED_FILES],
        },
      },
      {
        extends: true,
        test: {
          name: "demo-seed",
          include: DEMO_SEED_FILES,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
