import { cn } from "@/lib/utils";

export function Progress({
  value,
  className,
  label,
}: {
  value: number;
  className?: string;
  label?: string;
}) {
  const safeValue = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={safeValue}
      className={cn("h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]", className)}
    >
      <div
        className="h-full rounded-full bg-[var(--accent)] transition-[width] motion-reduce:transition-none"
        style={{ width: `${safeValue}%` }}
      />
    </div>
  );
}
