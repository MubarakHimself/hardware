"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  FileClock,
  GitMerge,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Scissors,
  ShieldAlert,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  errorMessage,
  getProject,
  listProjects,
  mergeProject,
  refreshProjectMetadata,
  splitProject,
  updateProject,
} from "@/lib/client/api";
import type { UiJob, UiProject } from "@/lib/client/contracts";
import { cn } from "@/lib/utils";

type AdminMode = "edit" | "merge" | "split" | "audit";

const modes: Array<{
  id: AdminMode;
  label: string;
  icon: typeof Pencil;
}> = [
  { id: "edit", label: "Edit", icon: Pencil },
  { id: "merge", label: "Merge", icon: GitMerge },
  { id: "split", label: "Split", icon: Scissors },
  { id: "audit", label: "Audit & refresh", icon: FileClock },
];

function jobLabel(type: UiJob["type"]): string {
  return type.replaceAll("_", " ");
}

export function ProjectAdminDialog({
  open,
  onOpenChange,
  project,
  onProjectChange,
  onNotice,
  onError,
  onOpenHistory,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: UiProject;
  onProjectChange: (project: UiProject) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onOpenHistory: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<AdminMode>("edit");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [primaryUrl, setPrimaryUrl] = useState(project.primaryUrl);
  const [reviewState, setReviewState] = useState(project.reviewState);
  const [targets, setTargets] = useState<UiProject[]>([]);
  const [targetsLoaded, setTargetsLoaded] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [mergeConfirmation, setMergeConfirmation] = useState("");
  const [splitName, setSplitName] = useState("");
  const [splitDescription, setSplitDescription] = useState("");
  const [splitPrimaryUrl, setSplitPrimaryUrl] = useState("");
  const [sightingIds, setSightingIds] = useState<string[]>([]);
  const [linkIds, setLinkIds] = useState<string[]>([]);
  const [queuedJobs, setQueuedJobs] = useState<UiJob[]>([]);

  useEffect(() => {
    if (!open || mode !== "merge" || targetsLoaded) return;
    const query = new URLSearchParams({
      limit: "100",
      sort: "name",
      view: "list",
    });
    listProjects(query)
      .then((page) =>
        setTargets(page.projects.filter((item) => item.id !== project.id)),
      )
      .catch((cause) => setLocalError(errorMessage(cause)))
      .finally(() => setTargetsLoaded(true));
  }, [mode, open, project.id, targetsLoaded]);

  const selectedTarget = useMemo(
    () => targets.find((item) => item.id === targetId) ?? null,
    [targetId, targets],
  );

  function fail(cause: unknown) {
    const message = errorMessage(cause);
    setLocalError(message);
    onError(message);
  }

  async function submitEdit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setLocalError(null);
    try {
      await updateProject(project, {
        name: name.trim(),
        description: description.trim() || null,
        primaryUrl: primaryUrl.trim() || null,
        reviewState,
      });
      const updated = await getProject(project.id);
      onProjectChange(updated);
      onNotice(`Project updated at version ${updated.version}; the edit was audited.`);
      onOpenChange(false);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function submitMerge(event: FormEvent) {
    event.preventDefault();
    if (!selectedTarget || mergeConfirmation !== project.name) return;
    setBusy(true);
    setLocalError(null);
    try {
      const currentTarget = await getProject(selectedTarget.id);
      const result = await mergeProject(project, currentTarget);
      onNotice(`Merged into ${currentTarget.name}; provenance and the audit trail were retained.`);
      onOpenChange(false);
      router.replace(`/projects/${result.targetProjectId}`);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function submitSplit(event: FormEvent) {
    event.preventDefault();
    if (!sightingIds.length) return;
    setBusy(true);
    setLocalError(null);
    try {
      const result = await splitProject(project, {
        name: splitName.trim(),
        description: splitDescription.trim() || undefined,
        primaryUrl: splitPrimaryUrl.trim() || null,
        sightingIds,
        linkIds,
      });
      onProjectChange({ ...project, version: result.sourceVersion });
      onNotice(`Created ${splitName.trim()} from the selected provenance; the split was audited.`);
      onOpenChange(false);
      router.push(`/projects/${result.projectId}`);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function refreshMetadata() {
    setBusy(true);
    setLocalError(null);
    try {
      const result = await refreshProjectMetadata(project.id);
      setQueuedJobs(result.jobs);
      onNotice(
        `${result.jobs.length} metadata ${result.jobs.length === 1 ? "job" : "jobs"} queued or already active.`,
      );
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  function toggleSelection(
    id: string,
    selected: string[],
    setSelected: (value: string[]) => void,
  ) {
    setSelected(
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id],
    );
  }

  function moveAdminTab(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const current = modes.findIndex((item) => item.id === mode);
    const next = event.key === "Home"
      ? modes[0]
      : event.key === "End"
        ? modes[modes.length - 1]
        : event.key === "ArrowRight"
          ? modes[(current + 1) % modes.length]
          : modes[(current - 1 + modes.length) % modes.length];
    setMode(next.id);
    setLocalError(null);
    requestAnimationFrame(() =>
      document.getElementById(`project-admin-tab-${next.id}`)?.focus(),
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-[var(--backdrop)] backdrop-blur-[2px]" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-8">
          <Dialog.Popup className="relative w-[900px] rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-2xl outline-none">
            <div className="flex items-start justify-between gap-5 border-b border-[var(--line)] p-6">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="accent">Owner tools</Badge>
                  <span className="text-[10px] text-[var(--muted)]">Version {project.version}</span>
                </div>
                <Dialog.Title className="mt-2 text-xl font-bold tracking-[-0.03em]">
                  Manage {project.name}
                </Dialog.Title>
                <Dialog.Description className="mt-1.5 max-w-2xl text-sm leading-6 text-[var(--muted-strong)]">
                  Consequential library changes use optimistic versions and append a safe audit summary.
                </Dialog.Description>
              </div>
              <Dialog.Close
                className={buttonVariants({ variant: "ghost", size: "icon" })}
                aria-label="Close project controls"
              >
                <X className="size-4" />
              </Dialog.Close>
            </div>

            <div className="grid min-h-[30rem] grid-cols-[12rem_minmax(0,1fr)]">
              <div
                className="flex flex-col gap-1 border-r border-[var(--line)] p-3"
                role="tablist"
                aria-label="Project tools"
                onKeyDown={moveAdminTab}
              >
                {modes.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      id={`project-admin-tab-${item.id}`}
                      aria-selected={mode === item.id}
                      aria-controls={`project-admin-${item.id}`}
                      tabIndex={mode === item.id ? 0 : -1}
                      onClick={() => {
                        setMode(item.id);
                        setLocalError(null);
                      }}
                      className={cn(
                        "inline-flex min-w-fit items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                        mode === item.id
                          ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                          : "text-[var(--muted-strong)] hover:bg-[var(--surface-raised)]",
                      )}
                    >
                      <Icon className="size-3.5" /> {item.label}
                    </button>
                  );
                })}
              </div>

              <div className="p-6">
                {localError && (
                  <div className="mb-5 rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] p-3 text-xs font-medium text-[var(--danger)]" role="alert">
                    {localError}
                  </div>
                )}

                {mode === "edit" && (
                  <form id="project-admin-edit" role="tabpanel" aria-labelledby="project-admin-tab-edit" onSubmit={submitEdit}>
                    <h3 className="text-sm font-bold">Editorial metadata</h3>
                    <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">Correct the personal library record without changing source provenance.</p>
                    <div className="mt-5 space-y-4">
                      <label className="block text-xs font-semibold">Name<Input className="mt-2" value={name} onChange={(event) => setName(event.target.value)} maxLength={300} required autoFocus /></label>
                      <label className="block text-xs font-semibold">Description<textarea className="mt-2 min-h-28 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-xs leading-5 outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={10000} /></label>
                      <label className="block text-xs font-semibold">Primary URL<Input className="mt-2" type="url" value={primaryUrl} onChange={(event) => setPrimaryUrl(event.target.value)} maxLength={2048} /></label>
                      <label className="block text-xs font-semibold">Review state<select className="mt-2 h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-xs" value={reviewState} onChange={(event) => setReviewState(event.target.value as UiProject["reviewState"])}><option value="unreviewed">Unreviewed</option><option value="reviewed">Reviewed</option><option value="needs_review">Needs review</option></select></label>
                    </div>
                    <div className="mt-6 flex justify-end gap-2"><Dialog.Close className={buttonVariants({ variant: "secondary" })}>Cancel</Dialog.Close><Button type="submit" variant="accent" disabled={busy || !name.trim()}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Pencil className="size-3.5" />}Save version {project.version + 1}</Button></div>
                  </form>
                )}

                {mode === "merge" && (
                  <form id="project-admin-merge" role="tabpanel" aria-labelledby="project-admin-tab-merge" onSubmit={submitMerge}>
                    <div className="flex gap-3 rounded-xl border border-[var(--danger-line)] bg-[var(--danger-soft)] p-4"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" /><div><h3 className="text-sm font-bold text-[var(--danger)]">Merge this record into another project</h3><p className="mt-1 text-[11px] leading-5 text-[var(--muted-strong)]">Sightings, links, compatible personal state, repository data, and audit history move to the target. This URL will redirect to it.</p></div></div>
                    <label className="mt-5 block text-xs font-semibold">Target project<select className="mt-2 h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-xs" value={targetId} onChange={(event) => setTargetId(event.target.value)} required><option value="">Choose a target</option>{targets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                    <label className="mt-4 block text-xs font-semibold">Type “{project.name}” to confirm<Input className="mt-2" value={mergeConfirmation} onChange={(event) => setMergeConfirmation(event.target.value)} autoComplete="off" /></label>
                    <div className="mt-6 flex justify-end gap-2"><Dialog.Close className={buttonVariants({ variant: "secondary" })}>Cancel</Dialog.Close><Button type="submit" variant="danger" disabled={busy || !selectedTarget || mergeConfirmation !== project.name}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <GitMerge className="size-3.5" />}Merge project</Button></div>
                  </form>
                )}

                {mode === "split" && (
                  <form id="project-admin-split" role="tabpanel" aria-labelledby="project-admin-tab-split" onSubmit={submitSplit}>
                    <h3 className="text-sm font-bold">Create a project from selected provenance</h3>
                    <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">At least one sighting is required. Selected links move with the new project.</p>
                    <div className="mt-5 grid grid-cols-2 gap-4"><label className="block text-xs font-semibold">New project name<Input className="mt-2" value={splitName} onChange={(event) => setSplitName(event.target.value)} required maxLength={300} /></label><label className="block text-xs font-semibold">Primary URL<Input className="mt-2" type="url" value={splitPrimaryUrl} onChange={(event) => setSplitPrimaryUrl(event.target.value)} placeholder="Defaults to the first sighting" /></label></div>
                    <label className="mt-4 block text-xs font-semibold">Description<textarea className="mt-2 min-h-20 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-xs" value={splitDescription} onChange={(event) => setSplitDescription(event.target.value)} maxLength={10000} /></label>
                    <fieldset className="mt-5"><legend className="text-xs font-bold">Sightings to move</legend><div className="mt-2 max-h-36 space-y-2 overflow-y-auto rounded-lg border border-[var(--line)] p-2">{project.sightings.map((sighting) => <label key={sighting.id} className="flex cursor-pointer items-start gap-2 rounded-md p-2 text-[11px] hover:bg-[var(--surface-raised)]"><input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={sightingIds.includes(sighting.id)} onChange={() => toggleSelection(sighting.id, sightingIds, setSightingIds)} /><span><span className="block font-semibold">{sighting.videoTitle} · {sighting.timestamp}</span><span className="block text-[10px] text-[var(--muted)]">{sighting.channel}</span></span></label>)}</div></fieldset>
                    {project.links.length > 0 && <fieldset className="mt-4"><legend className="text-xs font-bold">Links to move (optional)</legend><div className="mt-2 max-h-28 space-y-1 overflow-y-auto rounded-lg border border-[var(--line)] p-2">{project.links.map((link) => <label key={link.id} className="flex cursor-pointer items-start gap-2 rounded-md p-2 text-[11px] hover:bg-[var(--surface-raised)]"><input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={linkIds.includes(link.id)} onChange={() => toggleSelection(link.id, linkIds, setLinkIds)} /><span className="min-w-0"><span className="block font-semibold">{link.label || link.kind}</span><span className="block truncate text-[10px] text-[var(--muted)]">{link.normalizedUrl}</span></span></label>)}</div></fieldset>}
                    <div className="mt-6 flex justify-end gap-2"><Dialog.Close className={buttonVariants({ variant: "secondary" })}>Cancel</Dialog.Close><Button type="submit" variant="accent" disabled={busy || !splitName.trim() || sightingIds.length === 0}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Scissors className="size-3.5" />}Create split project</Button></div>
                  </form>
                )}

                {mode === "audit" && (
                  <div id="project-admin-audit" role="tabpanel" aria-labelledby="project-admin-tab-audit">
                    <h3 className="text-sm font-bold">Audit and source refresh</h3>
                    <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">Metadata refreshes use durable, idempotent jobs. Safe failure summaries appear in Radar without exposing payloads or credentials.</p>
                    <div className="mt-5 grid grid-cols-2 gap-3"><button type="button" onClick={() => { onOpenChange(false); onOpenHistory(); }} className="rounded-xl border border-[var(--line)] p-4 text-left hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"><FileClock className="size-4 text-[var(--accent-strong)]" /><span className="mt-3 block text-xs font-bold">Open immutable history</span><span className="mt-1 block text-[10px] leading-4 text-[var(--muted)]">Review editorial, merge, split, and source events.</span></button><button type="button" onClick={refreshMetadata} disabled={busy} className="rounded-xl border border-[var(--line)] p-4 text-left hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-60"><RefreshCw className={cn("size-4 text-[var(--accent-strong)]", busy && "animate-spin")} /><span className="mt-3 block text-xs font-bold">Refresh source metadata</span><span className="mt-1 block text-[10px] leading-4 text-[var(--muted)]">Queue website and verified repository refreshes.</span></button></div>
                    {queuedJobs.length > 0 && <div className="mt-5 rounded-xl border border-[var(--success-line)] bg-[var(--success-soft)] p-4" role="status"><p className="text-xs font-bold text-[var(--success)]">Metadata jobs ready</p><ul className="mt-3 space-y-2">{queuedJobs.map((job) => <li key={job.id} className="rounded-lg border border-[var(--success-line)] bg-[var(--surface)] p-3"><div className="flex items-center justify-between gap-3"><span className="text-[10px] font-bold capitalize">{jobLabel(job.type)}</span><Badge variant="success">{job.state}</Badge></div><p className="mt-1 break-all font-mono text-[9px] text-[var(--muted)]">{job.id}</p></li>)}</ul></div>}
                  </div>
                )}
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
