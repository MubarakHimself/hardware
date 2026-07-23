"use client";

import { ArrowRight, Check, CircleAlert, GitPullRequestArrow, Inbox, LoaderCircle, Radio, RefreshCw, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MetricCard } from "@/components/hardware/metric-card";
import { ProjectMiniRow } from "@/components/hardware/project-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { decideRepositoryCandidate, errorMessage, listChannels, listJobs, listProjects, listRepositoryCandidates, retryJob } from "@/lib/client/api";
import type { UiChannel, UiJob, UiProject, UiRepositoryCandidate } from "@/lib/client/contracts";

function jobTitle(job: UiJob): string {
  return job.type.replaceAll("_", " ");
}

function jobBadge(job: UiJob): "neutral" | "accent" | "success" | "danger" | "warning" {
  if (job.state === "failed") return "danger";
  if (job.state === "succeeded") return "success";
  if (job.state === "running") return "accent";
  if (job.state === "cancelled") return "warning";
  return "neutral";
}

export function RadarClient() {
  const [projects, setProjects] = useState<UiProject[]>([]);
  const [candidates, setCandidates] = useState<UiRepositoryCandidate[]>([]);
  const [channels, setChannels] = useState<UiChannel[]>([]);
  const [jobs, setJobs] = useState<UiJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ limit: "100", sort: "recently_seen", view: "cards" });
    Promise.all([
      listProjects(query),
      listRepositoryCandidates(),
      listChannels(),
      listJobs(30),
    ])
      .then(([projectPage, candidateRows, channelRows, jobRows]) => {
        if (!active) return;
        setProjects(projectPage.projects);
        setCandidates(candidateRows.filter((candidate) => candidate.state === "pending"));
        setChannels(channelRows);
        setJobs(jobRows);
      })
      .catch((cause) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const newProjects = useMemo(() => projects.filter((project) => project.isNew).slice(0, 5), [projects]);
  const sightings = useMemo(() => projects.reduce((total, project) => total + project.sightingCount, 0), [projects]);
  const attentionChannels = channels.filter((channel) => channel.status === "attention").length;

  async function decide(candidate: UiRepositoryCandidate, decision: "approve" | "reject") {
    setBusyId(candidate.id);
    setError(null);
    try {
      await decideRepositoryCandidate(candidate.id, decision, decision === "reject" ? "Not the same project" : undefined);
      setCandidates((items) => items.filter((item) => item.id !== candidate.id));
      setNotice(`${candidate.repository} ${decision === "approve" ? "approved" : "rejected"}. The audited decision was added to project history.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function retry(job: UiJob) {
    setBusyId(job.id);
    setError(null);
    try {
      const result = await retryJob(job.id);
      setJobs((items) =>
        items.map((item) =>
          item.id === job.id
            ? {
                ...item,
                state: result.state === "running" ? "running" : "queued",
                attempts: 0,
                safeErrorCode: null,
                safeErrorSummary: null,
                canRetry: false,
              }
            : item,
        ),
      );
      setNotice(`Retry queued for job ${job.id}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <Card className="grid min-h-72 place-items-center shadow-none"><div className="text-center"><LoaderCircle className="mx-auto size-6 animate-spin text-[var(--accent)] motion-reduce:animate-none" /><p className="mt-3 text-xs text-[var(--muted)]">Reading the latest library activity</p></div></Card>;
  }

  return (
    <>
      {(notice || error) && (
        <div className={`mb-5 flex items-center gap-3 rounded-xl border px-4 py-3 text-xs ${error ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]" : "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"}`} role={error ? "alert" : "status"}>
          {error ? <CircleAlert className="size-4 shrink-0" /> : <Check className="size-4 shrink-0" />}<span className="flex-1 font-medium">{error ?? notice}</span><button onClick={() => { setNotice(null); setError(null); }} aria-label="Dismiss message"><X className="size-3.5" /></button>
        </div>
      )}

      <div className="grid grid-cols-4 gap-3">
        <MetricCard label="Library window" value={projects.length.toLocaleString()} detail="most recently seen canonical projects" icon={Inbox} tone="accent" />
        <MetricCard label="Independent sightings" value={sightings.toLocaleString()} detail="preserved across the loaded project window" icon={Radio} tone="success" />
        <MetricCard label="Repository review" value={String(candidates.length)} detail="candidate matches need your decision" icon={GitPullRequestArrow} tone="warning" />
        <MetricCard label="Sources needing attention" value={String(attentionChannels)} detail="retryable source warnings or failures" icon={RefreshCw} />
      </div>

      <Card className="mt-6 overflow-hidden shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-sm font-bold text-[var(--ink)]">Job queue</h2>
            <p className="mt-1 text-[10px] text-[var(--muted)]">
              Local ingestion activity with safe failure summaries
            </p>
          </div>
          <Badge>{jobs.length} visible</Badge>
        </div>
        {jobs.length === 0 ? (
          <div className="p-8 text-center text-xs text-[var(--muted)]">No visible ingestion jobs yet.</div>
        ) : (
          <div className="divide-y divide-[var(--line)]">
            {jobs.slice(0, 10).map((job) => (
              <div key={job.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold capitalize text-[var(--ink)]">{jobTitle(job)}</span>
                    <Badge variant={jobBadge(job)}>{job.state}</Badge>
                    {job.requestedByMe && <Badge variant="accent">requested by you</Badge>}
                  </div>
                  <p className="mt-1 break-all font-mono text-[9px] text-[var(--muted)]">{job.id}</p>
                  {(job.totalItems > 0 || job.warningCount > 0 || job.failureCount > 0) && (
                    <p className="mt-2 text-[10px] text-[var(--muted-strong)]">
                      {job.completedItems}/{job.totalItems} complete · {job.warningCount} warnings · {job.failureCount} failures
                    </p>
                  )}
                  {job.safeErrorSummary && (
                    <div className="mt-2 rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--danger)]">
                      <span className="font-bold">{job.safeErrorCode ?? "JOB_FAILED"}:</span> {job.safeErrorSummary}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[9px] text-[var(--muted)]">Attempts {job.attempts}/{job.maxAttempts}</span>
                  {job.canRetry && (
                    <Button size="sm" variant="secondary" onClick={() => retry(job)} disabled={busyId === job.id} aria-label={`Retry ${jobTitle(job)} job`}>
                      {busyId === job.id ? <LoaderCircle className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Retry
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-6 grid grid-cols-[minmax(0,1.55fr)_minmax(20rem,.8fr)] gap-5">
        <Card className="overflow-hidden shadow-none">
          <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4"><div><h2 className="text-sm font-bold text-[var(--ink)]">Latest project sightings</h2><p className="mt-1 text-[10px] text-[var(--muted)]">New canonical projects and fresh sightings from monitored descriptions</p></div><Link href="/inventory" className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent-strong)] hover:underline">All projects <ArrowRight className="size-3" /></Link></div>
          {newProjects.length === 0 ? <div className="p-8 text-center text-xs text-[var(--muted)]">No unreviewed projects in the current library window.</div> : <div className="divide-y divide-[var(--line)] p-2">{newProjects.map((project) => <div key={project.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1"><ProjectMiniRow project={project} /><div className="flex items-center gap-2 pr-3"><Badge variant={project.repositoryState === "verified" ? "success" : project.repositoryState === "candidate" ? "warning" : "neutral"}>{project.repositoryState === "verified" ? "Repository verified" : project.repositoryState === "candidate" ? "Review candidate" : "Website only"}</Badge><span className="w-22 text-right text-[10px] text-[var(--muted)]">{project.seenAt}</span></div></div>)}</div>}
        </Card>

        <div className="space-y-5">
            <Card className="overflow-hidden shadow-none">
              <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4"><div><h2 className="text-sm font-bold text-[var(--ink)]">Repository review</h2><p className="mt-1 text-[10px] text-[var(--muted)]">Search matches never attach automatically</p></div><Badge variant="warning">{candidates.length} pending</Badge></div>
              {candidates.length === 0 ? <div className="p-8 text-center"><Check className="mx-auto size-5 text-[var(--success)]" /><p className="mt-2 text-xs font-semibold text-[var(--ink)]">Review queue clear</p></div> : <div className="divide-y divide-[var(--line)]">{candidates.map((candidate) => <div key={candidate.id} className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><Link href={`/projects/${candidate.projectId}`} className="text-xs font-bold text-[var(--ink)] hover:text-[var(--accent-strong)]">{candidate.projectName}</Link><p className="mt-1 truncate font-mono text-[10px] text-[var(--muted-strong)]">{candidate.repository}</p></div><Badge variant="warning">{candidate.score}% match</Badge></div><p className="mt-3 text-[10px] leading-4 text-[var(--muted)]">{candidate.evidence.slice(0, 2).join(" · ") || "Candidate evidence recorded"}</p><div className="mt-3 flex items-center gap-2"><Button size="sm" variant="accent" onClick={() => decide(candidate, "approve")} disabled={busyId === candidate.id}><Check className="size-3" /> Approve</Button><Button size="sm" variant="secondary" onClick={() => decide(candidate, "reject")} disabled={busyId === candidate.id}><X className="size-3" /> Reject</Button></div></div>)}</div>}
            </Card>

            <Card className="p-5 shadow-none"><div className="flex items-center justify-between"><div><h2 className="text-sm font-bold text-[var(--ink)]">Source pulse</h2><p className="mt-1 text-[10px] text-[var(--muted)]">Most recent ingestion status</p></div><RefreshCw className="size-4 text-[var(--accent)]" /></div><div className="mt-4 space-y-3">{channels.length === 0 ? <p className="text-xs text-[var(--muted)]">No monitored channels.</p> : channels.slice(0, 5).map((channel) => <div key={channel.id} className="flex items-center gap-3"><span className="grid size-7 place-items-center rounded-lg bg-[var(--surface-raised)] text-[9px] font-black text-[var(--muted-strong)]">{channel.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-semibold text-[var(--ink)]">{channel.name}</span><span className="block truncate text-[9px] text-[var(--muted)]">{channel.lastSync}</span></span>{channel.status === "attention" ? <CircleAlert className="size-3.5 text-[var(--warning)]" /> : <span className="size-1.5 rounded-full bg-[var(--success)]" />}</div>)}</div><Link href="/channels" className="mt-4 inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--accent-strong)] hover:underline">Open source operations <ArrowRight className="size-3" /></Link></Card>
        </div>
      </div>
    </>
  );
}
