import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "prisma/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/lint-fixtures/**"],
    environment: "node",
    // next-auth imports "next/server" without an extension; let Vite resolve it like Next does.
    server: { deps: { inline: ["next-auth"] } },
    testTimeout: 30_000,
    globalSetup: ["src/test/global-setup.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});
