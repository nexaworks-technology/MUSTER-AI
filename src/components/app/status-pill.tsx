import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const statusPillVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] leading-tight font-medium whitespace-nowrap transition-colors",
  {
    variants: {
      variant: {
        neutral: "bg-secondary text-secondary-foreground border border-border/50",
        primary: "bg-primary/10 text-primary border border-primary/20",
        accent: "bg-accent text-accent-foreground border border-accent/40",
        success:
          "bg-success-soft text-success-soft-foreground border border-success-soft-foreground/20",
        warning:
          "bg-warning-soft text-warning-soft-foreground border border-warning-soft-foreground/20",
        danger:
          "bg-danger-soft text-danger-soft-foreground border border-danger-soft-foreground/20",
        healthy:
          "bg-risk-healthy-soft text-risk-healthy-soft-foreground border border-risk-healthy-soft-foreground/20",
        watch:
          "bg-risk-watch-soft text-risk-watch-soft-foreground border border-risk-watch-soft-foreground/20",
        atRisk:
          "bg-risk-at-risk-soft text-risk-at-risk-soft-foreground border border-risk-at-risk-soft-foreground/20",
      },
      size: {
        sm: "px-1.5 py-0.5 text-[10px]",
        md: "px-2 py-0.5 text-[11px]",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "md",
    },
  },
);

const dotVariants = cva("size-1.5 shrink-0 rounded-full", {
  variants: {
    variant: {
      neutral: "bg-muted-foreground",
      primary: "bg-primary",
      accent: "bg-accent-foreground",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-danger",
      healthy: "bg-risk-healthy",
      watch: "bg-risk-watch",
      atRisk: "bg-risk-at-risk",
    },
  },
  defaultVariants: {
    variant: "neutral",
  },
});

export interface StatusPillProps
  extends React.ComponentProps<"span">, VariantProps<typeof statusPillVariants> {
  withDot?: boolean;
}

export function StatusPill({
  className,
  variant = "neutral",
  size = "md",
  withDot = true,
  children,
  ...props
}: StatusPillProps) {
  return (
    <span className={cn(statusPillVariants({ variant, size }), className)} {...props}>
      {withDot ? <span aria-hidden="true" className={dotVariants({ variant })} /> : null}
      <span>{children}</span>
    </span>
  );
}
