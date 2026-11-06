"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Active styles per nav kind; tokens only. `tab` matches the Account 360 tab nav. */
const ACTIVE_CLASSES = {
  sidebar: "bg-accent text-accent-foreground font-medium",
  tab: "border-primary hover:border-primary text-primary font-medium",
} as const;

type NavLinkProps = ComponentProps<typeof Link> & { variant?: keyof typeof ACTIVE_CLASSES };

function hrefPath(href: NavLinkProps["href"]): string {
  const raw = typeof href === "string" ? href : (href.pathname ?? "");
  return raw.split(/[?#]/)[0] ?? "";
}

/** `/` matches only itself; any other href matches itself and its sub-routes. */
function isActive(pathname: string | null, href: string): boolean {
  if (!pathname || !href) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The same `Link`, plus `aria-current="page"` and an active style on the current route. */
export function NavLink({ variant = "sidebar", className, ...props }: NavLinkProps) {
  const pathname = usePathname();
  const active = isActive(pathname, hrefPath(props.href));
  return (
    <Link
      {...props}
      aria-current={active ? "page" : undefined}
      className={cn(className, active && ACTIVE_CLASSES[variant])}
    />
  );
}
