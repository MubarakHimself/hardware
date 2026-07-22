import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone?: "neutral" | "success" | "warning" | "accent";
}) {
  const tones = {
    neutral: "bg-[var(--surface-raised)] text-[var(--muted-strong)]",
    success: "bg-[var(--success-soft)] text-[var(--success)]",
    warning: "bg-[var(--warning-soft)] text-[var(--warning)]",
    accent: "bg-[var(--accent-soft)] text-[var(--accent-strong)]",
  };

  return (
    <Card className="flex min-h-31 flex-col justify-between p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs font-semibold text-[var(--muted-strong)]">{label}</p>
        <span className={`grid size-8 place-items-center rounded-lg ${tones[tone]}`}>
          <Icon className="size-4" />
        </span>
      </div>
      <div>
        <p className="text-2xl font-bold tracking-[-0.04em] text-[var(--ink)]">{value}</p>
        <p className="mt-1 text-[11px] text-[var(--muted)]">{detail}</p>
      </div>
    </Card>
  );
}
