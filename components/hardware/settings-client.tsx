"use client";

import {
  Check,
  Database,
  HardDrive,
  KeyRound,
  Laptop,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  TerminalSquare,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { PageHeading } from "@/components/hardware/page-heading";
import {
  useTheme,
  type ThemePreference,
} from "@/components/hardware/theme-provider";
import { cn } from "@/lib/utils";

const themes: Array<{
  value: ThemePreference;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    value: "system",
    label: "System",
    description: "Follow this computer",
    icon: Laptop,
  },
  {
    value: "light",
    label: "Light",
    description: "Bright research desk",
    icon: Sun,
  },
  {
    value: "dark",
    label: "Dark",
    description: "Low-light desk",
    icon: Moon,
  },
];

const operations = [
  ["Start Hardware", ".\\hardware.ps1 start"],
  ["Create backup", ".\\hardware.ps1 backup"],
  ["Check services", ".\\hardware.ps1 status"],
  ["Install daily backup", ".\\hardware.ps1 install-backup-task"],
] as const;

export function SettingsClient() {
  const { preference, resolvedTheme, setPreference } = useTheme();

  return (
    <div className="mx-auto w-full max-w-[1180px]">
      <PageHeading
        eyebrow="Personal local"
        title="Settings"
        description="Appearance, local runtime boundaries, provider readiness, and recovery controls for this computer."
      />

      <div className="mt-7 grid grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)] gap-5">
        <div className="space-y-5">
          <Card className="p-5 shadow-none">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-bold">Appearance</h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  System is the default. Your choice stays on this device.
                </p>
              </div>
              <span className="rounded-full border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-1 text-[10px] font-bold capitalize text-[var(--muted-strong)]">
                {resolvedTheme} active
              </span>
            </div>
            <div className="mt-5 grid grid-cols-3 gap-3" role="radiogroup" aria-label="Color theme">
              {themes.map(({ value, label, description, icon: Icon }) => {
                const selected = preference === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setPreference(value)}
                    className={cn(
                      "relative rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--canvas)]",
                      selected
                        ? "border-[var(--accent-line)] bg-[var(--accent-soft)]"
                        : "border-[var(--line)] bg-[var(--surface-subtle)] hover:border-[var(--line-strong)]",
                    )}
                  >
                    <Icon className={cn("size-5", selected ? "text-[var(--accent-strong)]" : "text-[var(--muted)]")} />
                    <span className="mt-4 block text-xs font-bold">{label}</span>
                    <span className={cn("mt-1 block text-[10px]", selected ? "text-[var(--muted-strong)]" : "text-[var(--muted)]")}>{description}</span>
                    {selected && <Check className="absolute right-3 top-3 size-3.5 text-[var(--accent-strong)]" />}
                  </button>
                );
              })}
            </div>
          </Card>

          <Card className="p-5 shadow-none">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-[var(--success-soft)] text-[var(--success)]"><ShieldCheck className="size-4" /></span>
              <div><h2 className="text-sm font-bold">Local boundary</h2><p className="mt-0.5 text-[10px] text-[var(--muted)]">Hardware is available only on this computer.</p></div>
            </div>
            <div className="mt-5 grid grid-cols-3 gap-3">
              {[
                [Laptop, "Loopback only", "127.0.0.1"],
                [Database, "Persistent", "PostgreSQL volume"],
                [KeyRound, "Private keys", "Host environment"],
              ].map(([Icon, label, value]) => (
                <div key={String(label)} className="rounded-xl border border-[var(--line)] bg-[var(--surface-subtle)] p-4">
                  <Icon className="size-4 text-[var(--muted)]" />
                  <p className="mt-3 text-xs font-bold">{String(label)}</p>
                  <p className="mt-1 text-[10px] text-[var(--muted)]">{String(value)}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 rounded-lg border border-[var(--warning-line)] bg-[var(--warning-soft)] px-3 py-2.5 text-[10px] leading-4 text-[var(--warning)]">
              Do not expose this local port to another device or a tunnel.
            </p>
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="p-5 shadow-none">
            <div className="flex items-center gap-3"><TerminalSquare className="size-4 text-[var(--accent-strong)]" /><h2 className="text-sm font-bold">Local operations</h2></div>
            <div className="mt-4 divide-y divide-[var(--line)] rounded-xl border border-[var(--line)]">
              {operations.map(([label, command]) => (
                <div key={label} className="flex items-center justify-between gap-4 px-3 py-3">
                  <span className="text-[10px] font-semibold text-[var(--muted-strong)]">{label}</span>
                  <code className="select-all rounded-md bg-[var(--surface-sunken)] px-2 py-1 font-mono text-[9px] text-[var(--ink-soft)]">{command}</code>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-5 shadow-none">
            <div className="flex items-center gap-3"><HardDrive className="size-4 text-[var(--accent-strong)]" /><h2 className="text-sm font-bold">Recovery policy</h2></div>
            <ul className="mt-4 space-y-3 text-[10px] leading-4 text-[var(--muted-strong)]">
              <li className="flex gap-2"><Check className="mt-0.5 size-3 shrink-0 text-[var(--success)]" />Encrypted before files enter the host backup folder.</li>
              <li className="flex gap-2"><Check className="mt-0.5 size-3 shrink-0 text-[var(--success)]" />Daily archives for seven days, plus four Sunday restore points.</li>
              <li className="flex gap-2"><RefreshCw className="mt-0.5 size-3 shrink-0 text-[var(--accent-strong)]" />Mandatory pre-update backup and explicit restore confirmation.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
