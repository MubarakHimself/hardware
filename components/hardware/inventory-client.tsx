"use client";

import { ArchiveX, Check, Grid2X2, List, LoaderCircle, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ProjectCard } from "@/components/hardware/project-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { errorMessage, listProjects } from "@/lib/client/api";
import type { UiProject } from "@/lib/client/contracts";
import { cn } from "@/lib/utils";

type ViewMode = "cards" | "list";

const selectClass = "h-9 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--muted-strong)] shadow-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]";

function facetChannelOptions(facets: Record<string, unknown>, projects: UiProject[]) {
  const candidates: Array<{ id: string; name: string }> = [];
  if (Array.isArray(facets.channels)) {
    for (const value of facets.channels) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.id === "string" && typeof (entry.name ?? entry.title) === "string") candidates.push({ id: entry.id, name: String(entry.name ?? entry.title) });
    }
  }
  for (const project of projects) {
    for (const sighting of project.sightings) if (sighting.channelId) candidates.push({ id: sighting.channelId, name: sighting.channel });
  }
  return [...new Map(candidates.map((item) => [item.id, item])).values()];
}

function facetOptions(facets: Record<string, unknown>, key: "languages" | "licenses" | "collections") {
  const values = facets[key];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const entry = value as Record<string, unknown>;
    return typeof entry.id === "string" && typeof entry.name === "string"
      ? [{ id: entry.id, name: entry.name }]
      : [];
  });
}

export function InventoryClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const currentQ = searchParams.get("q") ?? "";
  const [projects, setProjects] = useState<UiProject[]>([]);
  const [facets, setFacets] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [loadedSearchKey, setLoadedSearchKey] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const view = (searchParams.get("view") === "list" ? "list" : "cards") as ViewMode;
  const repository = searchParams.get("repository") ?? "all";
  const language = searchParams.get("language") ?? "all";
  const license = searchParams.get("license") ?? "all";
  const activity = searchParams.get("activity") ?? "all";
  const collection = searchParams.get("collection") ?? "all";
  const channel = searchParams.get("channel") ?? "all";
  const impressive = searchParams.get("impressive") === "true";
  const sort = searchParams.get("sort") ?? "recently_seen";
  const isLoading = loading || loadedSearchKey !== searchKey;

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams(searchKey);
    query.set("limit", "24");
    query.delete("cursor");
    listProjects(query)
      .then((result) => {
        if (!active) return;
        setProjects(result.projects);
        setFacets(result.facets);
        setNextCursor(result.nextCursor);
        setLoadedSearchKey(searchKey);
        setError(null);
      })
      .catch((cause) => {
        if (!active) return;
        setLoadedSearchKey(searchKey);
        setError(errorMessage(cause));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reloadToken, searchKey]);

  function updateParams(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchKey);
    for (const [key, value] of Object.entries(updates)) {
      if (!value || value === "all" || (key === "view" && value === "cards")) next.delete(key);
      else next.set(key, value);
    }
    next.delete("cursor");
    const suffix = next.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = String(new FormData(event.currentTarget).get("q") ?? "").trim();
    updateParams({ q: query || null });
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const query = new URLSearchParams(searchKey);
      query.set("limit", "24");
      query.set("cursor", nextCursor);
      const result = await listProjects(query);
      setProjects((current) => {
        const rows = new Map(current.map((project) => [project.id, project]));
        for (const project of result.projects) rows.set(project.id, project);
        return [...rows.values()];
      });
      setNextCursor(result.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  const channels = useMemo(() => facetChannelOptions(facets, projects), [facets, projects]);
  const languages = useMemo(() => {
    const values = facetOptions(facets, "languages");
    if (values.length > 0) return values;
    return [...new Set(projects.map((project) => project.language).filter((value): value is string => Boolean(value)))].sort().map((value) => ({ id: value, name: value }));
  }, [facets, projects]);
  const licenses = useMemo(() => facetOptions(facets, "licenses"), [facets]);
  const collections = useMemo(() => facetOptions(facets, "collections"), [facets]);
  const selectedChannelName = channels.find((item) => item.id === channel)?.name ?? "Selected";
  const activeFilters = [
    currentQ && { key: "q", label: `Search: ${currentQ}` },
    repository !== "all" && { key: "repository", label: `Repository: ${repository}` },
    language !== "all" && { key: "language", label: `Language: ${language}` },
    license !== "all" && { key: "license", label: `License: ${license}` },
    activity !== "all" && { key: "activity", label: `Activity: ${activity}` },
    collection !== "all" && { key: "collection", label: `Collection: ${collections.find((item) => item.id === collection)?.name ?? "Selected"}` },
    channel !== "all" && { key: "channel", label: `Channel: ${selectedChannelName}` },
    impressive && { key: "impressive", label: "Impressive" },
  ].filter(Boolean) as { key: string; label: string }[];

  return (
    <>
      <Card className="mb-5 p-4 shadow-none">
        <form onSubmit={submitSearch} className="relative min-w-0" role="search">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" />
          <Input key={currentQ} name="q" defaultValue={currentQ} placeholder="Search names, descriptions, repository topics, videos…" aria-label="Search project inventory" className="pl-9 pr-18" />
          <Button type="submit" variant="ghost" size="sm" className="absolute right-1 top-1 h-8 px-2.5">Search</Button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-3">
          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]"><SlidersHorizontal className="size-3" /> Filters</span>
          <label><span className="sr-only">Repository status</span><select className={selectClass} value={repository} onChange={(event) => updateParams({ repository: event.target.value })}><option value="all">All repositories</option><option value="attached">Verified repo</option><option value="pending">Needs review</option><option value="none">No repo</option></select></label>
          <label><span className="sr-only">Programming language</span><select className={selectClass} value={language} onChange={(event) => updateParams({ language: event.target.value })}><option value="all">All languages</option>{languages.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
          <label><span className="sr-only">License</span><select className={selectClass} value={license} onChange={(event) => updateParams({ license: event.target.value })}><option value="all">All licenses</option>{licenses.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
          <label><span className="sr-only">Repository activity</span><select className={selectClass} value={activity} onChange={(event) => updateParams({ activity: event.target.value })}><option value="all">Any activity</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option><option value="stale">Stale</option></select></label>
          <label><span className="sr-only">Collection</span><select className={selectClass} value={collection} onChange={(event) => updateParams({ collection: event.target.value })}><option value="all">All collections</option>{collections.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
          <label><span className="sr-only">Source channel</span><select className={selectClass} value={channel} onChange={(event) => updateParams({ channel: event.target.value })}><option value="all">All channels</option>{channels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <Button size="sm" variant={impressive ? "accent" : "secondary"} aria-pressed={impressive} onClick={() => updateParams({ impressive: impressive ? null : "true" })}><Sparkles className="size-3.5" /> Impressive</Button>
        </div>
        {activeFilters.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[var(--line)] pt-3">{activeFilters.map((filter) => <button key={filter.key} onClick={() => updateParams({ [filter.key]: null })} className="inline-flex items-center gap-1 rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2.5 py-1 text-[10px] font-semibold text-[var(--accent-strong)] hover:border-[var(--accent)]">{filter.label}<X className="size-3" /></button>)}<button onClick={() => router.replace(pathname, { scroll: false })} className="ml-1 text-[10px] font-semibold text-[var(--muted)] hover:text-[var(--ink)]">Clear all</button></div>}
      </Card>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm font-bold text-[var(--ink)]">{isLoading ? "Loading library…" : `${projects.length} loaded projects`}</p><p className="mt-0.5 text-[10px] text-[var(--muted)]">One canonical record per project · exact provenance retained</p></div>
        <div className="flex items-center gap-2"><label><span className="sr-only">Sort projects</span><select className={selectClass} value={sort} onChange={(event) => updateParams({ sort: event.target.value })}><option value="recently_seen">Newest sightings</option><option value="repository_activity">Repository activity</option><option value="newest">Recently added</option><option value="name">Name A–Z</option></select></label><div className="flex rounded-lg border border-[var(--line)] bg-[var(--surface)] p-0.5 shadow-sm" aria-label="Library view"><button className={cn("grid size-8 place-items-center rounded-md text-[var(--muted)]", view === "cards" && "bg-[var(--surface-raised)] text-[var(--ink)] shadow-sm")} onClick={() => updateParams({ view: "cards" })} aria-label="Card view" aria-pressed={view === "cards"}><Grid2X2 className="size-3.5" /></button><button className={cn("grid size-8 place-items-center rounded-md text-[var(--muted)]", view === "list" && "bg-[var(--surface-raised)] text-[var(--ink)] shadow-sm")} onClick={() => updateParams({ view: "list" })} aria-label="Compact list view" aria-pressed={view === "list"}><List className="size-3.5" /></button></div></div>
      </div>

      {isLoading ? (
        <Card className="grid min-h-72 place-items-center p-8 shadow-none"><div className="text-center"><LoaderCircle className="mx-auto size-6 animate-spin text-[var(--accent)] motion-reduce:animate-none" /><p className="mt-3 text-xs text-[var(--muted)]">Reading your project library</p></div></Card>
      ) : error && projects.length === 0 ? (
        <Card className="grid min-h-72 place-items-center p-8 text-center" role="alert"><div><ArchiveX className="mx-auto size-6 text-[var(--danger)]" /><h2 className="mt-3 text-base font-bold">Library unavailable</h2><p className="mt-1 max-w-md text-xs leading-5 text-[var(--muted)]">{error}</p><Button className="mt-4" variant="secondary" size="sm" onClick={() => setReloadToken((value) => value + 1)}>Try again</Button></div></Card>
      ) : projects.length === 0 ? (
        <Card className="grid min-h-80 place-items-center p-8 text-center"><div><span className="mx-auto grid size-12 place-items-center rounded-xl bg-[var(--surface-raised)] text-[var(--muted)]"><ArchiveX className="size-5" /></span><h2 className="mt-4 text-base font-bold text-[var(--ink)]">No projects match</h2><p className="mt-1 max-w-sm text-xs leading-5 text-[var(--muted)]">Try a broader term or remove one of the active filters. Nothing in your library was changed.</p><Button className="mt-4" variant="secondary" size="sm" onClick={() => router.replace(pathname)}><Check className="size-3.5" /> Reset filters</Button></div></Card>
      ) : (
        <>
          {error && <div className="mb-4 rounded-xl border border-[var(--danger-line)] bg-[var(--danger-soft)] px-4 py-3 text-xs font-medium text-[var(--danger)]" role="alert">{error}</div>}
          {view === "cards" ? <div className="grid grid-cols-3 gap-4">{projects.map((project) => <ProjectCard key={project.id} project={project} />)}</div> : <div className="space-y-2">{projects.map((project) => <ProjectCard key={project.id} project={project} compact />)}</div>}
          {nextCursor && <div className="mt-6 flex justify-center"><Button variant="secondary" onClick={loadMore} disabled={loadingMore} aria-label="Load more projects">{loadingMore ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : null}{loadingMore ? "Loading more…" : "Load more projects"}</Button></div>}
        </>
      )}
    </>
  );
}
