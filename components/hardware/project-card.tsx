"use client";

import {
  Check,
  CircleHelp,
  Clock3,
  ExternalLink,
  GitFork,
  Radio,
  Sparkles,
  Star,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { saveProjectPreference } from "@/lib/client/api";
import type { UiProject } from "@/lib/client/contracts";
import { cn, contrastTextColor, formatCompactNumber, formatTimestampUrl } from "@/lib/utils";

function RepoBadge({ project }: { project: UiProject }) {
  if (project.repositoryState === "verified") {
    return <Badge variant="success"><Check className="size-3" /> Verified repo</Badge>;
  }
  if (project.repositoryState === "candidate") {
    return <Badge variant="warning"><CircleHelp className="size-3" /> Review repo</Badge>;
  }
  return <Badge>No public repo</Badge>;
}

function PreferenceButton({ project }: { project: UiProject }) {
  const [impressive, setImpressive] = useState(project.isImpressive);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function toggle() {
    const next = !impressive;
    setImpressive(next);
    setBusy(true);
    setError(false);
    try {
      await saveProjectPreference(project.id, next);
    } catch {
      setImpressive(!next);
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end">
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      aria-pressed={impressive}
      aria-label={impressive ? `Remove ${project.name} from Impressive` : `Mark ${project.name} as Impressive`}
      onClick={toggle}
      disabled={busy}
    >
      <Sparkles className={cn("size-4", impressive && "fill-[var(--accent)] text-[var(--accent)]")} />
    </Button>
      {error && <span className="mt-0.5 text-[9px] font-semibold text-[var(--danger)]" role="alert">Save failed; try again</span>}
    </div>
  );
}

function useProjectHref(project: UiProject) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const returnTo = pathname === "/inventory"
    ? `${pathname}${searchParams.size ? `?${searchParams.toString()}` : ""}`
    : "/inventory";
  return `/projects/${project.slug || project.id}?returnTo=${encodeURIComponent(returnTo)}`;
}

export function ProjectCard({ project, compact = false }: { project: UiProject; compact?: boolean }) {
  const latest = project.sightings[0];
  const projectHref = useProjectHref(project);

  if (compact) {
    return (
      <Card className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 p-3 transition-colors hover:border-[var(--line-strong)] sm:grid-cols-[auto_minmax(12rem,1.2fr)_minmax(8rem,.8fr)_minmax(8rem,.7fr)_auto]">
        <Link href={projectHref} className="grid size-9 place-items-center rounded-lg text-xs font-black shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" style={{ background: project.accent, color: contrastTextColor(project.accent) }} aria-label={`Open ${project.name}`}>
          {project.initials}
        </Link>
        <div className="min-w-0">
          <Link href={projectHref} className="truncate text-sm font-bold text-[var(--ink)] hover:underline">{project.name}</Link>
          <p className="mt-0.5 truncate text-[11px] text-[var(--muted)]">{project.domain}</p>
        </div>
        <div className="hidden min-w-0 sm:block"><RepoBadge project={project} /></div>
        <div className="hidden min-w-0 sm:block">
          <p className="truncate text-xs font-medium text-[var(--muted-strong)]">{project.language ?? "Website"}</p>
          <p className="mt-0.5 truncate text-[10px] text-[var(--muted)]">{project.activityLabel}</p>
        </div>
        <div className="flex items-center gap-1">
          <PreferenceButton project={project} />
          <Link href={projectHref} className="rounded-md px-2 py-1 text-xs font-semibold text-[var(--accent-strong)] hover:bg-[var(--accent-soft)]">Open</Link>
        </div>
      </Card>
    );
  }

  return (
    <Card className="group flex min-h-[21.5rem] flex-col overflow-hidden transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-[var(--line-strong)] hover:shadow-[0_10px_28px_rgba(32,45,37,0.07)] motion-reduce:transform-none">
      <div className="flex items-start justify-between gap-4 p-5 pb-3">
        <Link href={projectHref} className="grid size-11 place-items-center rounded-xl text-sm font-black shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2" style={{ background: project.accent, color: contrastTextColor(project.accent) }} aria-label={`Open ${project.name}`}>
          {project.initials}
        </Link>
        <div className="flex items-center gap-1">
          {project.isNew && <Badge variant="accent">New</Badge>}
          <PreferenceButton project={project} />
        </div>
      </div>

      <div className="flex flex-1 flex-col px-5 pb-4">
        <Link href={projectHref} className="w-fit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
          <h3 className="text-base font-bold tracking-[-0.02em] text-[var(--ink)] group-hover:text-[var(--accent-strong)]">{project.name}</h3>
        </Link>
        {project.primaryUrl ? (
          <a href={project.primaryUrl} target="_blank" rel="noreferrer" className="mt-1 flex w-fit max-w-full items-center gap-1 truncate text-[11px] font-medium text-[var(--muted)] hover:text-[var(--accent-strong)]">
            <span className="truncate">{project.domain}</span><ExternalLink className="size-2.5 shrink-0" />
          </a>
        ) : <p className="mt-1 text-[11px] text-[var(--muted)]">Source URL pending</p>}
        <p className="mt-3 line-clamp-3 text-xs leading-5 text-[var(--muted-strong)]">{project.description}</p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <RepoBadge project={project} />
          {project.language && <Badge>{project.language}</Badge>}
          {project.license && project.license !== "Unknown" && <Badge>{project.license}</Badge>}
        </div>

        <div className="mt-auto pt-4">
          <div className="flex items-center gap-3 text-[10px] font-medium text-[var(--muted)]">
            {project.stars !== undefined && <span className="inline-flex items-center gap-1"><Star className="size-3" />{formatCompactNumber(project.stars)}</span>}
            <span className="inline-flex items-center gap-1"><Radio className="size-3" />{project.sightingCount} {project.sightingCount === 1 ? "sighting" : "sightings"}</span>
            <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{project.activityLabel}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--surface-subtle)] px-5 py-3">
        {latest ? (
          <a href={formatTimestampUrl(latest.videoId, latest.timestampSeconds)} target="_blank" rel="noreferrer" className="min-w-0 text-[10px] text-[var(--muted)] hover:text-[var(--accent-strong)]">
            <span className="font-semibold text-[var(--muted-strong)]">{latest.channel}</span><span className="mx-1.5">·</span><span>{latest.timestamp}</span>
          </a>
        ) : <span className="text-[10px] text-[var(--muted)]">No sightings yet</span>}
        <Link href={projectHref} className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold text-[var(--muted-strong)] hover:text-[var(--accent-strong)]">
          {project.collectionIds.length ? `${project.collectionIds.length} collections` : "Organize"}
        </Link>
      </div>
    </Card>
  );
}

export function ProjectMiniRow({ project }: { project: UiProject }) {
  const projectHref = useProjectHref(project);
  return (
    <Link href={projectHref} className="group flex items-center gap-3 rounded-lg p-2.5 transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg text-[10px] font-black" style={{ background: project.accent, color: contrastTextColor(project.accent) }}>{project.initials}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-bold text-[var(--ink)] group-hover:text-[var(--accent-strong)]">{project.name}</span>
        <span className="mt-0.5 block truncate text-[10px] text-[var(--muted)]">{project.domain}</span>
      </span>
      <GitFork className="size-3.5 text-[var(--muted)]" />
    </Link>
  );
}
