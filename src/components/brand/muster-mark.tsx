import { PRODUCT_NAME } from "@/config/product";
import { cn } from "@/lib/utils";
import { MARK_PATH, MARK_VIEWBOX } from "./mark-geometry";

/**
 * Colour comes only from the two brand variants (docs/BRAND.md): `primary` (deep ink violet, for
 * light surfaces) and `reversed` (warm white, for dark and brand panels). `auto` picks one of the
 * two by theme; it never introduces a third colour. The geometry is the traced original knot
 * (mark-geometry.ts), the same at every size.
 */
const VARIANT = {
  primary: "text-brand-violet",
  reversed: "text-brand-warm-white",
  auto: "text-brand-mark",
} as const;

export type MarkVariant = keyof typeof VARIANT;

export function MusterMark({
  variant = "auto",
  className,
}: {
  variant?: MarkVariant;
  className?: string;
}) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className={cn(VARIANT[variant], className)}
    >
      <path d={MARK_PATH} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/**
 * Mark + wordmark lockup. The wordmark is the product name in Sora, medium weight, wide tracking
 * (reference sheet). The mark's colour and the wordmark's colour use the same variant.
 */
export function MusterLockup({
  variant = "auto",
  size = "md",
  className,
}: {
  variant?: MarkVariant;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const s = {
    sm: { mark: "h-4", text: "text-sm", gap: "gap-1.5" },
    md: { mark: "h-5", text: "text-base", gap: "gap-2" },
    lg: { mark: "h-8", text: "text-2xl", gap: "gap-3" },
    xl: { mark: "h-16 md:h-20", text: "text-5xl md:text-6xl", gap: "gap-5" },
  }[size];
  return (
    <span className={cn("inline-flex items-center", s.gap, className)}>
      <MusterMark variant={variant} className={cn(s.mark, "w-auto")} />
      <span
        className={cn(
          "font-display font-medium tracking-[0.14em] uppercase",
          VARIANT[variant],
          s.text,
        )}
      >
        {PRODUCT_NAME}
      </span>
    </span>
  );
}
