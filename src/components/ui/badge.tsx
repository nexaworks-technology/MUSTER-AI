import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Soft-tint pill: a light tint of one semantic token with its AA-checked foreground
 * (see the contrast table in src/app/globals.css). Meaning is always carried by the word inside,
 * never by colour alone. The health-band variants add a small dot in the band colour.
 */
const dot =
  "before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs leading-4 font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        neutral: "bg-secondary text-secondary-foreground",
        accent: "bg-accent text-accent-foreground",
        success: "bg-success-soft text-success-soft-foreground",
        warning: "bg-warning-soft text-warning-soft-foreground",
        danger: "bg-danger-soft text-danger-soft-foreground",
        healthy: `bg-risk-healthy-soft text-risk-healthy-soft-foreground ${dot}`,
        watch: `bg-risk-watch-soft text-risk-watch-soft-foreground ${dot}`,
        atRisk: `bg-risk-at-risk-soft text-risk-at-risk-soft-foreground ${dot}`,
        unknown: `bg-risk-unknown-soft text-risk-unknown-soft-foreground ${dot}`,
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
