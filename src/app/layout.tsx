import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { PRODUCT_NAME } from "@/config/product";
import "./globals.css";

// Self-hosted at build time by next/font (no runtime request to Google, allowed by font-src 'self').
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
};

// Dynamic rendering: Next applies the per-request CSP nonce (src/proxy.ts) only while rendering.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
