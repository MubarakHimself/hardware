import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--ink)] text-white shadow-sm hover:bg-[var(--ink-soft)]",
        accent:
          "bg-[var(--accent)] text-white shadow-sm hover:bg-[var(--accent-strong)]",
        secondary:
          "border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-sm hover:bg-[var(--surface-raised)]",
        ghost:
          "text-[var(--muted-strong)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]",
        danger:
          "bg-[var(--danger-soft)] text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-11 px-5",
        icon: "size-9 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);

Button.displayName = "Button";
