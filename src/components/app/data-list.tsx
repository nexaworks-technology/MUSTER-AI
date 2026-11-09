import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared Premium Data Pattern (Design 2.0 - S4).
 * Compact density, sticky headers, subtle hover lift/tint, hover row actions,
 * and consistent avatar initials chips.
 */

export interface DataListCardProps extends React.ComponentProps<"div"> {
  header?: React.ReactNode;
}

export function DataListCard({ className, header, children, ...props }: DataListCardProps) {
  return (
    <div
      className={cn("surface overflow-hidden transition-shadow duration-200", className)}
      {...props}
    >
      {header}
      {children}
    </div>
  );
}

export type DataListHeaderProps = React.ComponentProps<"div">;

export function DataListHeader({ className, children, ...props }: DataListHeaderProps) {
  return (
    <div
      className={cn(
        "border-border bg-muted/60 text-muted-foreground sticky top-0 z-10 flex items-center justify-between border-b px-4 py-2 text-[11px] font-semibold tracking-wider uppercase backdrop-blur-sm",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type DataListBodyProps = React.ComponentProps<"div">;

export function DataListBody({ className, children, ...props }: DataListBodyProps) {
  return (
    <div className={cn("divide-border divide-y", className)} {...props}>
      {children}
    </div>
  );
}

export interface DataListRowProps extends React.ComponentProps<"div"> {
  isInteractive?: boolean;
}

export function DataListRow({
  className,
  isInteractive = true,
  children,
  ...props
}: DataListRowProps) {
  return (
    <div
      className={cn(
        "group relative flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-150",
        isInteractive && "hover:bg-muted/50",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type DataListRowActionsProps = React.ComponentProps<"div">;

export function DataListRowActions({ className, children, ...props }: DataListRowActionsProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 md:opacity-0",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** Generates a consistent 1-2 letter initial monogram from a name or title. */
export function getInitials(name?: string | null): string {
  if (!name) return "--";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "--";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1];
  if (!last) return first.slice(0, 2).toUpperCase();
  const a = first[0] ?? "";
  const b = last[0] ?? "";
  return (a + b).toUpperCase() || "--";
}

/** Soft pastel palette mapped deterministically from string hash for avatar backgrounds. */
const AVATAR_PALETTE = [
  "bg-primary/10 text-primary border-primary/20",
  "bg-indigo-500/10 text-indigo-700 border-indigo-500/20",
  "bg-sky-500/10 text-sky-700 border-sky-500/20",
  "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  "bg-violet-500/10 text-violet-700 border-violet-500/20",
  "bg-amber-500/10 text-amber-700 border-amber-500/20",
  "bg-rose-500/10 text-rose-700 border-rose-500/20",
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export interface DataListAvatarProps extends React.ComponentProps<"span"> {
  name?: string | null;
  size?: "sm" | "md" | "lg";
}

export function DataListAvatar({ name, size = "md", className, ...props }: DataListAvatarProps) {
  const initials = getInitials(name);
  const colorClass = name
    ? AVATAR_PALETTE[hashString(name) % AVATAR_PALETTE.length]
    : "bg-muted text-muted-foreground border-border";

  const sizeClasses = {
    sm: "size-6 text-[10px]",
    md: "size-7 text-[11px]",
    lg: "size-8 text-xs",
  }[size];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border font-semibold select-none",
        sizeClasses,
        colorClass,
        className,
      )}
      {...props}
    >
      {initials}
    </span>
  );
}
