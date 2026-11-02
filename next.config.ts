import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  // Native / worker-thread packages must be loaded by Node, not bundled.
  serverExternalPackages: ["@node-rs/argon2", "pino"],
};

export default nextConfig;
