"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { cn } from "@/lib/utils";

export function TabNav({ tabs }: { tabs: Array<{ label: string; href: Route }> }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Account sections" className="border-border overflow-x-auto border-b">
      <ul className="flex gap-1 text-sm">
        {tabs.map((t) => {
          const active = pathname === t.href;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block border-b-2 px-3 py-2 whitespace-nowrap",
                  active
                    ? "border-primary font-medium"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
