"use client";

import {
  ArrowLeft,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  FileText,
  FolderKanban,
  GitBranch,
  Github,
  History,
  Link2,
  LoaderCircle,
  Radio,
  ShieldCheck,
  Settings2,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type KeyboardEvent } from "react";
import { useHardwareRuntime } from "@/components/hardware/runtime-context";
import { ProjectAdminDialog } from "@/components/hardware/project-admin-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  decideRepositoryCandidate,
  errorMessage,
  getProject,
  listCollections,
  listRepositoryCandidates,
  saveProjectNote,
  saveProjectPreference,
  setCollectionMembership,
} from "@/lib/client/api";
import type { UiCollection, UiProject, UiRepositoryCandidate } from "@/lib/client/contracts";
import { cn, formatCompactNumber, formatTimestampUrl } from "@/lib/utils";

const tabs = ["Overview", "Sightings", "Repository", "History"] as const;
type DetailTab = (typeof tabs)[number];

function DetailTabs({ value, onChange }: { value: DetailTab; onChange: (value: DetailTab) => void }) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = tabs.indexOf(value);
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : event.key === "ArrowRight" ? tabs[(current + 1) % tabs.length] : tabs[(current - 1 + tabs.length) % tabs.length];
    onChange(next);
    requestAnimationFrame(() => document.getElementById(`tab-${next.toLowerCase()}`)?.focus());
  }

  return (
    <div role="tablist" aria-label="Project details" onKeyDown={onKeyDown} className="flex gap-1 overflow-x-auto border-b border-[var(--line)] px-4 sm:px-6">
      {tabs.map((tab) => <button key={tab} role="tab" id={`tab-${tab.toLowerCase()}`} aria-selected={value === tab} aria-controls={`panel-${tab.toLowerCase()}`} tabIndex={value === tab ? 0 : -1} onClick={() => onChange(tab)} className={cn("relative min-w-fit px-3 py-3.5 text-xs font-semibold text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)]", value === tab && "text-[var(--ink)] after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--accent)]")}>{tab}</button>)}
    </div>
  );
}

export function ProjectDetailClient({ id }: { id: string }) {
  const { role } = useHardwareRuntime();
  const searchParams = useSearchParams();
  const requestedReturnTo = searchParams.get("returnTo");
  const returnTo = requestedReturnTo?.startsWith("/inventory") ? requestedReturnTo : "/inventory";
  const [project, setProject] = useState<UiProject | null>(null);
  const [collections, setCollections] = useState<UiCollection[]>([]);
  const [candidate, setCandidate] = useState<UiRepositoryCandidate | null>(null);
  const [tab, setTab] = useState<DetailTab>("Overview");
  const [note, setNote] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adminOpen, setAdminOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const candidates = role === "admin" ? listRepositoryCandidates() : Promise.resolve([]);
    Promise.all([getProject(id), listCollections(), candidates])
      .then(([projectRow, collectionRows, candidateRows]) => {
        if (!active) return;
        setProject(projectRow);
        setNote(projectRow.note);
        setCollections(collectionRows);
        setCandidate(candidateRows.find((item) => item.projectId === projectRow.id || item.projectId === projectRow.slug) ?? null);
      })
      .catch((cause) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, role]);

  async function toggleCollection(collection: UiCollection) {
    if (!project || !collection.canEdit) return;
    const present = !project.collectionIds.includes(collection.id);
    setBusy(`collection:${collection.id}`);
    setProject({ ...project, collectionIds: present ? [...project.collectionIds, collection.id] : project.collectionIds.filter((item) => item !== collection.id) });
    try {
      await setCollectionMembership(collection.id, project.id, present);
      setNotice(present ? `Added to ${collection.name}.` : `Removed from ${collection.name}.`);
    } catch (cause) {
      setProject(project);
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function toggleImpressive() {
    if (!project) return;
    const next = !project.isImpressive;
    const before = project;
    setProject({ ...project, isImpressive: next });
    setBusy("preference");
    try {
      await saveProjectPreference(project.id, next);
      setNotice(next ? "Marked Impressive for your account." : "Removed from your Impressive projects.");
    } catch (cause) {
      setProject(before);
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function saveNote() {
    if (!project) return;
    setBusy("note");
    setError(null);
    try {
      const saved = await saveProjectNote(project.id, note, project.noteVersion);
      setProject({ ...project, note: saved.body, noteVersion: saved.version });
      setNoteSaved(true);
      setNotice("Private note saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function decideCandidate(decision: "approve" | "reject") {
    if (!candidate || !project) return;
    setBusy("candidate");
    try {
      await decideRepositoryCandidate(candidate.id, decision, decision === "reject" ? "Not the same project" : undefined);
      setCandidate(null);
      if (decision === "approve") setProject({ ...project, repositoryState: "verified" });
      setNotice(`Repository candidate ${decision === "approve" ? "approved" : "rejected"}; the decision was audited.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function copyUrl() {
    if (!project?.primaryUrl) return;
    try {
      await navigator.clipboard.writeText(project.primaryUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError("The browser could not copy this URL.");
    }
  }

  if (loading) return <Card className="grid min-h-96 place-items-center"><div className="text-center"><LoaderCircle className="mx-auto size-6 animate-spin text-[var(--accent)] motion-reduce:animate-none" /><p className="mt-3 text-xs text-[var(--muted)]">Loading project provenance</p></div></Card>;
  if (!project) return <Card className="grid min-h-72 place-items-center p-8 text-center" role="alert"><div><CircleAlert className="mx-auto size-7 text-[var(--danger)]" /><h1 className="mt-3 text-base font-bold">Project unavailable</h1><p className="mt-1 text-xs text-[var(--muted)]">{error ?? "This project could not be found."}</p><Link href="/inventory" className="mt-4 inline-flex text-xs font-bold text-[var(--accent-strong)]">Return to Inventory</Link></div></Card>;

  return (
    <>
      <Link href={returnTo} className="mb-5 inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--muted-strong)] hover:text-[var(--ink)]"><ArrowLeft className="size-3.5" /> Back to Inventory</Link>
      {(error || notice) && <div className={`mb-5 flex items-center gap-3 rounded-xl border px-4 py-3 text-xs ${error ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]" : "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"}`} role={error ? "alert" : "status"}><span className="flex-1 font-medium">{error ?? notice}</span><button onClick={() => { setError(null); setNotice(null); }} aria-label="Dismiss message"><X className="size-3.5" /></button></div>}

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4"><span className="grid size-14 shrink-0 place-items-center rounded-2xl text-base font-black text-white shadow-sm" style={{ background: project.accent }}>{project.initials}</span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold tracking-[-0.04em] text-[var(--ink)] sm:text-[1.9rem]">{project.name}</h1>{project.repositoryState === "verified" && <Badge variant="success"><ShieldCheck className="size-3" /> Verified repository</Badge>}{project.repositoryState === "candidate" && <Badge variant="warning"><CircleAlert className="size-3" /> Candidate review</Badge>}</div><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted-strong)]">{project.description}</p><div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] font-medium text-[var(--muted)]"><span className="inline-flex items-center gap-1"><Radio className="size-3" /> {project.sightingCount} independent sightings</span><span className="inline-flex items-center gap-1"><Clock3 className="size-3" /> {project.activityLabel}</span><span className="inline-flex items-center gap-1"><Link2 className="size-3" /> {project.domain}</span></div></div></div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">{role === "admin" && <Button variant="secondary" size="sm" onClick={() => setAdminOpen(true)}><Settings2 className="size-3.5" /> Manage project</Button>}<Button variant={project.isImpressive ? "accent" : "secondary"} size="sm" aria-pressed={project.isImpressive} onClick={toggleImpressive} disabled={busy === "preference"}><Sparkles className={cn("size-3.5", project.isImpressive && "fill-white")} /> {project.isImpressive ? "Impressive" : "Mark impressive"}</Button><Button variant="secondary" size="sm" onClick={copyUrl} disabled={!project.primaryUrl}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "Copied" : "Copy URL"}</Button>{project.primaryUrl && <a href={project.primaryUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-[var(--ink)] px-3 text-xs font-semibold text-white hover:bg-[var(--ink-soft)]">Open project <ExternalLink className="size-3" /></a>}</div>
        </div>

        <DetailTabs value={tab} onChange={setTab} />
        <section role="tabpanel" id={`panel-${tab.toLowerCase()}`} aria-labelledby={`tab-${tab.toLowerCase()}`} className="p-4 sm:p-6">
          {tab === "Overview" && <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,.7fr)]"><div className="space-y-5"><Card className="p-5 shadow-none"><div className="flex items-center gap-2"><FileText className="size-4 text-[var(--accent-strong)]" /><h2 className="text-sm font-bold">Deterministic metadata</h2></div><p className="mt-4 text-sm leading-7 text-[var(--muted-strong)]">{project.description}</p><div className="mt-5 grid gap-4 border-t border-[var(--line)] pt-5 sm:grid-cols-2 lg:grid-cols-4"><div><p className="text-[9px] font-bold uppercase tracking-[0.11em] text-[var(--muted)]">Primary source</p><p className="mt-1.5 text-xs font-semibold">{project.domain}</p></div><div><p className="text-[9px] font-bold uppercase tracking-[0.11em] text-[var(--muted)]">Repository</p><p className="mt-1.5 text-xs font-semibold">{project.repositoryState === "verified" ? "Verified" : project.repositoryState === "candidate" ? "Pending approval" : "Not found"}</p></div><div><p className="text-[9px] font-bold uppercase tracking-[0.11em] text-[var(--muted)]">Language</p><p className="mt-1.5 text-xs font-semibold">{project.language ?? "Not available"}</p></div><div><p className="text-[9px] font-bold uppercase tracking-[0.11em] text-[var(--muted)]">License</p><p className="mt-1.5 text-xs font-semibold">{project.license ?? "Not available"}</p></div></div></Card><Card className="p-5 shadow-none"><h2 className="text-sm font-bold">Topics and retrieval signals</h2><p className="mt-1 text-[10px] text-[var(--muted)]">Fetched fields and editorial aliases are searchable; no AI summary is generated.</p><div className="mt-4 flex flex-wrap gap-2">{project.topics.length ? project.topics.map((topic) => <Badge key={topic}>{topic}</Badge>) : <span className="text-xs text-[var(--muted)]">No topics fetched yet.</span>}</div></Card></div>
            <div className="space-y-5"><Card className="p-5 shadow-none"><div className="flex items-center gap-2"><FolderKanban className="size-4 text-[var(--accent-strong)]" /><h2 className="text-sm font-bold">Your collections</h2></div><p className="mt-1 text-[10px] text-[var(--muted)]">A project can belong to several collections.</p><div className="mt-4 space-y-2">{collections.length === 0 ? <p className="text-xs text-[var(--muted)]">Create a collection first.</p> : collections.map((collection) => { const checked = project.collectionIds.includes(collection.id); return <label key={collection.id} className={cn("flex items-center gap-3 rounded-lg border border-[var(--line)] p-3", collection.canEdit ? "cursor-pointer hover:bg-[var(--surface-raised)]" : "cursor-not-allowed opacity-60")}><input type="checkbox" checked={checked} onChange={() => toggleCollection(collection)} disabled={!collection.canEdit || busy === `collection:${collection.id}`} className="size-4 accent-[var(--accent)]" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{collection.name}</span><span className="block text-[9px] text-[var(--muted)]">{collection.canEdit ? collection.visibility === "private" ? "Private" : "Workspace read-only" : "Workspace read-only · owned by another member"}</span></span>{checked && <Check className="size-3.5 text-[var(--success)]" />}</label>; })}</div></Card><Card className="p-5 shadow-none"><h2 className="text-sm font-bold">Private note</h2><p className="mt-1 text-[10px] text-[var(--muted)]">Visible only to you, even when a collection is shared.</p><textarea value={note} onChange={(event) => { setNote(event.target.value); setNoteSaved(false); }} className="mt-3 min-h-28 w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-xs leading-5 outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]" placeholder="What should you remember about this project?" maxLength={3000} /><div className="mt-2 flex items-center justify-between"><span className="text-[9px] text-[var(--muted)]">{note.length}/3000</span><Button size="sm" variant="secondary" onClick={saveNote} disabled={busy === "note" || note === project.note}>{noteSaved ? <Check className="size-3" /> : null}{busy === "note" ? "Saving…" : noteSaved ? "Saved" : "Save note"}</Button></div></Card></div></div>}

          {tab === "Sightings" && <div><div className="mb-4"><h2 className="text-sm font-bold">Source provenance</h2><p className="mt-1 text-[10px] text-[var(--muted)]">Every appearance stays independent, even when project identity is shared.</p></div>{project.sightings.length === 0 ? <Card className="p-8 text-center text-xs text-[var(--muted)] shadow-none">No retained source sightings.</Card> : <div className="space-y-3">{project.sightings.map((sighting, index) => <Card key={sighting.id} className="p-4 shadow-none sm:p-5"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div className="flex gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#f24b3f] text-[10px] font-black text-white">YT</span><div><p className="text-xs font-bold">{sighting.videoTitle}</p><p className="mt-1 text-[10px] text-[var(--muted)]">{sighting.channel} {sighting.channelHandle} · {sighting.publishedAt}</p></div></div><a href={formatTimestampUrl(sighting.videoId, sighting.timestampSeconds)} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 self-start rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-xs font-bold text-[var(--accent-strong)] hover:bg-[var(--surface-raised)]">{sighting.timestamp} <ExternalLink className="size-3" /></a></div><p className="mt-4 text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">Raw description segment</p><div className="mt-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface-subtle)] p-3 font-mono text-[10px] leading-5 text-[var(--muted-strong)]"><span className="mr-2 select-none text-[var(--muted)]">{String(index + 1).padStart(2, "0")}</span>{sighting.rawSegment || "Purged by source-retention policy"}</div><div className="mt-3 grid gap-3 text-[10px] sm:grid-cols-2"><div><p className="font-bold uppercase tracking-[0.08em] text-[var(--muted)]">Original URL</p><p className="mt-1 break-all text-[var(--muted-strong)]">{sighting.originalUrl}</p></div><div><p className="font-bold uppercase tracking-[0.08em] text-[var(--muted)]">Normalized URL</p><p className="mt-1 break-all text-[var(--muted-strong)]">{sighting.normalizedUrl}</p></div></div></Card>)}</div>}</div>}

          {tab === "Repository" && <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]"><Card className="p-5 shadow-none"><div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[var(--ink)] text-white"><Github className="size-5" /></span><div><h2 className="text-sm font-bold">{project.repositoryLabel ?? candidate?.repository ?? "No verified repository"}</h2><p className="mt-1 text-[10px] text-[var(--muted)]">{project.repositoryState === "verified" ? "Attached through deterministic identity evidence" : candidate ? "Search candidate — admin decision required" : "Website-only project"}</p></div></div>{project.repositoryUrl && <a href={project.repositoryUrl} target="_blank" rel="noreferrer" className="text-[var(--muted)] hover:text-[var(--ink)]"><ExternalLink className="size-4" /></a>}</div>{project.repositoryState === "verified" && <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><div><p className="text-[9px] font-bold uppercase text-[var(--muted)]">Default branch</p><p className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold"><GitBranch className="size-3" /> {project.repository?.defaultBranch ?? "Unknown"}</p></div><div><p className="text-[9px] font-bold uppercase text-[var(--muted)]">Stars</p><p className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold"><Star className="size-3" /> {formatCompactNumber(project.stars ?? 0)}</p></div><div><p className="text-[9px] font-bold uppercase text-[var(--muted)]">Language</p><p className="mt-1.5 text-xs font-semibold">{project.language ?? "Unknown"}</p></div><div><p className="text-[9px] font-bold uppercase text-[var(--muted)]">License</p><p className="mt-1.5 text-xs font-semibold">{project.license ?? "Unknown"}</p></div></div>}{candidate && role === "admin" && <div className="mt-6 rounded-xl border border-[var(--warning-line)] bg-[var(--warning-soft)] p-4"><p className="text-xs font-bold text-[var(--warning)]">Candidate evidence</p><ul className="mt-2 space-y-1 text-[10px] leading-5 text-[var(--muted-strong)]">{candidate.evidence.map((item) => <li key={item}>• {item}</li>)}</ul><div className="mt-4 flex gap-2"><Button variant="accent" size="sm" onClick={() => decideCandidate("approve")} disabled={busy === "candidate"}><Check className="size-3" /> Approve repository</Button><Button variant="secondary" size="sm" onClick={() => decideCandidate("reject")} disabled={busy === "candidate"}><X className="size-3" /> Reject</Button></div></div>}</Card><Card className="p-5 shadow-none"><h3 className="text-xs font-bold">Resolution order</h3><ol className="mt-4 space-y-4"><li className="flex gap-3"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--success-soft)] text-[9px] font-black text-[var(--success)]">1</span><span className="text-[10px] leading-4 text-[var(--muted-strong)]">Explicit public GitHub URL attaches automatically.</span></li><li className="flex gap-3"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--success-soft)] text-[9px] font-black text-[var(--success)]">2</span><span className="text-[10px] leading-4 text-[var(--muted-strong)]">One unambiguous repository found on the project website may attach.</span></li><li className="flex gap-3"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--warning-soft)] text-[9px] font-black text-[var(--warning)]">3</span><span className="text-[10px] leading-4 text-[var(--muted-strong)]">Search similarities always require administrator approval.</span></li></ol></Card></div>}

          {tab === "History" && <div className="max-w-3xl"><div className="mb-5 flex items-center gap-2"><History className="size-4 text-[var(--accent-strong)]" /><div><h2 className="text-sm font-bold">Project history</h2><p className="mt-0.5 text-[10px] text-[var(--muted)]">Source changes and consequential catalog edits are immutable.</p></div></div>{project.history.length === 0 ? <Card className="p-8 text-center text-xs text-[var(--muted)] shadow-none">No audit events have been recorded for this project yet.</Card> : <div className="space-y-0 border-l border-[var(--line-strong)] pl-5">{project.history.map((event) => <div key={`${event.action}:${event.createdAt}:${event.correlationId}`} className="relative pb-6"><span className="absolute -left-[1.85rem] grid size-5 place-items-center rounded-full border border-[var(--line)] bg-[var(--surface)] text-[var(--muted-strong)]"><Clock3 className="size-2.5" /></span><p className="text-xs font-bold">{event.action.replace(/[._]/g, " ")}</p><p className="mt-1 text-[9px] text-[var(--muted)]">{event.createdAt}{event.correlationId ? ` · ${event.correlationId}` : ""}</p></div>)}</div>}</div>}
        </section>
      </Card>
      {role === "admin" && adminOpen && (
        <ProjectAdminDialog
          open={adminOpen}
          onOpenChange={setAdminOpen}
          project={project}
          onProjectChange={setProject}
          onNotice={(message) => {
            setError(null);
            setNotice(message);
          }}
          onError={(message) => {
            setNotice(null);
            setError(message);
          }}
          onOpenHistory={() => setTab("History")}
        />
      )}
    </>
  );
}
