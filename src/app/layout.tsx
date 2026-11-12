import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { Inter, Sora } from "next/font/google";
import { THEME_COOKIE, parseTheme, themeAttribute } from "@/lib/theme";
import { PRODUCT_NAME } from "@/config/product";
import "./globals.css";

// Self-hosted at build time by next/font (no runtime request to Google, allowed by font-src 'self').
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
// Display face for the wordmark and page headings only. "optional" never swaps after first paint,
// and next/font preloads it and sizes a metric-matched fallback, so headings cannot shift (CLS 0).
const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "optional",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
};

// Dynamic rendering: Next applies the per-request CSP nonce (src/proxy.ts) only while rendering.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The saved theme is set on <html> on the server, so the first paint is already the right one.
  const theme = themeAttribute(parseTheme((await cookies()).get(THEME_COOKIE)?.value));
  return (
    <html
      lang="en"
      className={`${inter.variable} ${sora.variable}`}
      data-theme={theme}
      suppressHydrationWarning
    >
      <body className="glass-surfaces min-h-screen antialiased">{children}</body>
    </html>
  );
}
