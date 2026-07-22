import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex min-h-5 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-none",
  {
    variants: {
      variant: {
        neutral:
          "border-[var(--line)] bg-[var(--surface-raised)] text-[var(--muted-strong)]",
        success:
          "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]",
        warning:
          "border-[var(--warning-line)] bg-[var(--warning-soft)] text-[var(--warning)]",
        accent:
          "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent-strong)]",
        danger:
          "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
