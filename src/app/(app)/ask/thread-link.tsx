"use client";

import type { Route } from "next";
import { NavLink } from "@/components/app/nav-link";

/** One row of the thread list: plain text, a quiet hover wash, and the open thread marked. */
export function ThreadLink({ id, title }: { id: string; title: string }) {
  return (
    <NavLink
      variant="ask"
      href={`/ask/${id}` as Route}
      className="text-muted-foreground hover:bg-ask-wash hover:text-foreground focus-visible:ring-ring line-clamp-2 block rounded-lg px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      {title}
    </NavLink>
  );
}
