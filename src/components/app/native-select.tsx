import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Native <select> styled like shadcn inputs: fully keyboard and screen-reader accessible. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "border-input bg-card text-foreground focus-visible:border-ring focus-visible:ring-ring/30 h-9 rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
