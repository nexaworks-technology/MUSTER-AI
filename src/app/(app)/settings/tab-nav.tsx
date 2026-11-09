"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { cn } from "@/lib/utils";

export function SettingsTabNav({ tabs }: { tabs: Array<{ label: string; href: Route }> }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="border-b border-border/80 overflow-x-auto scrollbar-none">
      <ul className="flex gap-1 text-xs sm:text-sm">
        {tabs.map((t) => {
          // Exact match or active subroute match for settings tabs
          const active = pathname === t.href || (t.href !== "/settings" && pathname.startsWith(t.href));
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "focus-visible:ring-ring inline-block rounded-t-lg border-b-2 px-3.5 py-2.5 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset transition-all duration-150 text-xs sm:text-sm",
                  active
                    ? "border-primary text-primary font-semibold bg-primary/[0.04]"
                    : "text-muted-foreground hover:border-border/60 hover:text-foreground border-transparent",
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
