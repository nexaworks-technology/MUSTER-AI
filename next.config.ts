import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // M12 B7: the e2e production build uses its own output directory so it never replaces dev's.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  // Dev only: hosts other than localhost that may load dev assets/HMR, e.g. this Mac's LAN IP
  // when sharing `pnpm dev` over Wi-Fi. Comma-separated; empty means localhost only.
  allowedDevOrigins: (process.env.DEV_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
  reactStrictMode: true,
  typedRoutes: true,
  // Native / worker-thread packages must be loaded by Node, not bundled.
  serverExternalPackages: ["@node-rs/argon2", "pino"],
};

export default nextConfig;
