import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // M12 B7: the e2e production build uses its own output directory so it never replaces dev's.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  // Native / worker-thread packages must be loaded by Node, not bundled.
  serverExternalPackages: ["@node-rs/argon2", "pino"],
};

export default nextConfig;
