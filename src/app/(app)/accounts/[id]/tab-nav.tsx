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
                  "focus-visible:ring-ring inline-block rounded-t-md border-b-2 px-3 py-2.5 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset",
                  active
                    ? "border-primary text-primary font-medium"
                    : "text-muted-foreground hover:border-border hover:text-foreground border-transparent",
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
