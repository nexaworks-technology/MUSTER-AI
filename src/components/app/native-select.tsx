import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Native <select> styled like shadcn inputs: fully keyboard and screen-reader accessible. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "border-input bg-background focus-visible:ring-ring/50 h-9 rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
