import type { ReactNode } from "react";

export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end">
      <div className="max-w-3xl">
        {eyebrow && (
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--accent-strong)]">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-bold tracking-[-0.035em] text-[var(--ink)] sm:text-[2rem]">
          {title}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted-strong)]">
          {description}
        </p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
