import type { ComponentProps } from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Light empty state: the sentence stays exactly as written, set in a dashed surface with a quiet
 * icon. A paragraph (not a heading or a status), so it never changes the page outline.
 */
export function EmptyState({ className, children, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "text-muted-foreground border-border flex items-center gap-2.5 rounded-lg border border-dashed px-4 py-3 text-sm",
        className,
      )}
      {...props}
    >
      <Inbox aria-hidden="true" className="size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
