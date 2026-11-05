import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PRODUCT_NAME } from "@/config/product";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
};

// Dynamic rendering: Next applies the per-request CSP nonce (src/proxy.ts) only while rendering.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
