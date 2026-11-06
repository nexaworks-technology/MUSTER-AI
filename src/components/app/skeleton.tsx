import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Neutral loading block (token colours only). Hidden from assistive tech; see LoadingStatus. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("bg-muted animate-pulse rounded-md", className)}
      {...props}
    />
  );
}

/** The one announcement a loading screen makes. It never repeats a page heading. */
export function LoadingStatus() {
  return (
    <p role="status" className="sr-only">
      Loading…
    </p>
  );
}
