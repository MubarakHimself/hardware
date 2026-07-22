import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[0_1px_2px_rgba(22,28,24,0.035)]",
        className,
      )}
      {...props}
    />
  );
}
