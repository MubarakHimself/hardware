"use client";

import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileClock,
  FileWarning,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { errorMessage, listJobs, retryJob } from "@/lib/client/api";
import type { UiJob, UiJobState } from "@/lib/client/contracts";
import { cn } from "@/lib/utils";

type ReviewState = "open" | "resolved" | "ignored";
type ReviewDecision = Exclude<ReviewState, "open">;
type ActivityTab = "runs" | "reviews" | "history";

interface SourceReview {
  id: string;
  videoSourceId: string;
  youtubeVideoId: string;
  videoTitle: string | null;
  channelTitle: string;
  state: ReviewState;
  parserVersion: string;
  issueFingerprint: string;
  version: number;
  mentionCount: number;
  warningCount: number;
  errorCount: number;
  rejectedRowCount: number;
  ignoredLinkCount: number;
  diagnosticCodeCounts: Record<string, number>;
  jobId: string | null;
  job: { id: string; type: UiJob["type"]; state: UiJobState } | null;
  resolutionNote: string | null;
  resolvedByUserId: string | null;
  resolvedByDisplayName: string | null;
  resolvedAt: string | null;
  updatedAt: string;
}

interface SourceReviewPage {
  items: SourceReview[];
  nextCursor: string | null;
  totalCount: number;
  openCount: number;
}

interface AuditEvent {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  status: "succeeded" | "failed" | "info";
  beforeRelease: string | null;
  afterRelease: string | null;
  createdAt: string;
}

interface AuditEventPage {
  items: AuditEvent[];
  nextCursor: string | null;
  totalCount: number;
}

interface ApiEnvelope<T> {
  data?: T;
  detail?: string;
}

interface FeedStatus {
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

const REVIEW_PAGE_SIZE = 50;
const AUDIT_PAGE_SIZE = 50;
const TAB_ORDER: ActivityTab[] = ["runs", "reviews", "history"];

class ActivityRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ActivityRequestError";
    this.status = status;
  }
}

function initialFeedStatus(): FeedStatus {
  return { loaded: false, loading: true, error: null };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!response.ok || payload.data === undefined) {
    throw new ActivityRequestError(
      payload.detail || "The activity request failed.",
      response.status,
    );
  }
  return payload.data;
}

async function listReviews(cursor?: string): Promise<SourceReviewPage> {
  const search = new URLSearchParams({
    state: "open",
    limit: String(REVIEW_PAGE_SIZE),
  });
  if (cursor) search.set("cursor", cursor);
  return request<SourceReviewPage>(`/api/source-reviews?${search.toString()}`);
}

async function listAuditEvents(cursor?: string): Promise<AuditEventPage> {
  const search = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
  if (cursor) search.set("cursor", cursor);
  return request<AuditEventPage>(`/api/audit-events?${search.toString()}`);
}

async function updateReview(
  review: SourceReview,
  state: ReviewDecision,
  note?: string,
): Promise<void> {
  await request(`/api/source-reviews/${encodeURIComponent(review.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      state,
      ...(note ? { note } : {}),
      expectedIssueFingerprint: review.issueFingerprint,
      expectedVersion: review.version,
    }),
  });
}

function appendUnique<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !seen.has(item.id))];
}

function jobLabel(type: UiJob["type"]): string {
  const labels: Record<UiJob["type"], string> = {
    channel_resolve: "Channel setup",
    channel_backfill: "Channel history",
    channel_poll: "Channel sync",
    video_ingest: "Video description",
    youtube_revalidate: "YouTube recheck",
    website_metadata: "Website metadata",
    repository_resolve: "Repository match",
    repository_refresh: "Repository refresh",
  };
  return labels[type];
}

function stateBadge(state: UiJobState) {
  if (state === "succeeded") {
    return <Badge variant="success"><Check className="size-3" /> Complete</Badge>;
  }
  if (state === "failed") {
    return <Badge variant="danger"><AlertTriangle className="size-3" /> Failed</Badge>;
  }
  if (state === "running") {
    return <Badge variant="accent"><LoaderCircle className="size-3 animate-spin" /> Running</Badge>;
  }
  if (state === "cancelled") return <Badge>Cancelled</Badge>;
  return <Badge variant="accent"><Clock3 className="size-3" /> Queued</Badge>;
}

function dateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function reviewIssue(review: SourceReview): string {
  if (review.errorCount > 0) {
    return `${review.errorCount} parser ${review.errorCount === 1 ? "error" : "errors"}`;
  }
  if (review.warningCount > 0) {
    return `${review.warningCount} parser ${review.warningCount === 1 ? "warning" : "warnings"}`;
  }
  if (review.mentionCount === 0) return "No project mentions found";
  if (review.rejectedRowCount > 0) {
    return `${review.rejectedRowCount} rejected description rows`;
  }
  if (review.ignoredLinkCount > 0) {
    return `${review.ignoredLinkCount} unsupported links`;
  }
  return "Source needs review";
}

function auditLabel(action: string): string {
  const labels: Record<string, string> = {
    "local.update_succeeded": "Local update completed",
    "local.update_failed": "Local update rolled back",
    "local.update_rollback_succeeded": "Pre-update catalog restored",
    "local.restore_succeeded": "Backup restored",
    "local.restore_failed": "Restore rolled back",
  };
  return labels[action] ?? action.replaceAll(/[._-]+/gu, " ");
}

function LoadingState({ label }: { label: string }) {
  return (
    <div
      className="grid min-h-52 place-items-center text-[var(--muted)]"
      role="status"
      aria-live="polite"
    >
      <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function FeedFailure({
  title,
  detail,
  retrying,
  onRetry,
}: {
  title: string;
  detail: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="grid min-h-52 place-items-center px-6 text-center" role="alert">
      <div>
        <span className="mx-auto grid size-10 place-items-center rounded-xl bg-[var(--danger-soft)] text-[var(--danger)]">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-4 text-sm font-bold">{title}</p>
        <p className="mt-1 max-w-md text-xs leading-5 text-[var(--muted)]">{detail}</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-4"
          onClick={onRetry}
          disabled={retrying}
        >
          <RefreshCw className={retrying ? "size-3.5 animate-spin" : "size-3.5"} />
          Try again
        </Button>
      </div>
    </div>
  );
}

function RefreshWarning({ message }: { message: string }) {
  return (
    <div
      className="flex items-center gap-2 border-b border-[var(--warning-line)] bg-[var(--warning-soft)] px-5 py-2.5 text-[10px] font-medium text-[var(--warning)]"
      role="status"
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
      The latest refresh failed. Showing the last loaded data. {message}
    </div>
  );
}

export function ActivityClient() {
  const [tab, setTab] = useState<ActivityTab>("runs");
  const [jobs, setJobs] = useState<UiJob[]>([]);
  const [reviews, setReviews] = useState<SourceReview[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [jobsStatus, setJobsStatus] = useState<FeedStatus>(initialFeedStatus);
  const [reviewsStatus, setReviewsStatus] = useState<FeedStatus>(initialFeedStatus);
  const [auditsStatus, setAuditsStatus] = useState<FeedStatus>(initialFeedStatus);
  const [reviewsNextCursor, setReviewsNextCursor] = useState<string | null>(null);
  const [auditsNextCursor, setAuditsNextCursor] = useState<string | null>(null);
  const [reviewTotalCount, setReviewTotalCount] = useState(0);
  const [reviewOpenCount, setReviewOpenCount] = useState(0);
  const [auditTotalCount, setAuditTotalCount] = useState(0);
  const [reviewsLoadingMore, setReviewsLoadingMore] = useState(false);
  const [auditsLoadingMore, setAuditsLoadingMore] = useState(false);
  const [retryingJobIds, setRetryingJobIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [reviewDecisions, setReviewDecisions] = useState<
    Record<string, ReviewDecision>
  >({});
  const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tabRefs = useRef<Record<ActivityTab, HTMLButtonElement | null>>({
    runs: null,
    reviews: null,
    history: null,
  });
  const jobRowRefs = useRef(new Map<string, HTMLDivElement>());
  const initialLoadStarted = useRef(false);

  const loadJobs = useCallback(async () => {
    setJobsStatus((status) => ({ ...status, loading: true, error: null }));
    try {
      const nextJobs = await listJobs(75);
      setJobs(nextJobs);
      setJobsStatus({ loaded: true, loading: false, error: null });
    } catch (cause) {
      setJobsStatus((status) => ({
        ...status,
        loading: false,
        error: errorMessage(cause),
      }));
    }
  }, []);

  const loadReviews = useCallback(async (cursor?: string) => {
    const append = Boolean(cursor);
    if (append) {
      setReviewsLoadingMore(true);
    } else {
      setReviewsStatus((status) => ({ ...status, loading: true, error: null }));
    }
    try {
      const page = await listReviews(cursor);
      setReviews((items) => append ? appendUnique(items, page.items) : page.items);
      setReviewsNextCursor(page.nextCursor);
      setReviewTotalCount(page.totalCount);
      setReviewOpenCount(page.openCount);
      setReviewsStatus({ loaded: true, loading: false, error: null });
    } catch (cause) {
      setReviewsStatus((status) => ({
        ...status,
        loading: false,
        error: errorMessage(cause),
      }));
    } finally {
      if (append) setReviewsLoadingMore(false);
    }
  }, []);

  const loadAudits = useCallback(async (cursor?: string) => {
    const append = Boolean(cursor);
    if (append) {
      setAuditsLoadingMore(true);
    } else {
      setAuditsStatus((status) => ({ ...status, loading: true, error: null }));
    }
    try {
      const page = await listAuditEvents(cursor);
      setAuditEvents((items) => append ? appendUnique(items, page.items) : page.items);
      setAuditsNextCursor(page.nextCursor);
      setAuditTotalCount(page.totalCount);
      setAuditsStatus({ loaded: true, loading: false, error: null });
    } catch (cause) {
      setAuditsStatus((status) => ({
        ...status,
        loading: false,
        error: errorMessage(cause),
      }));
    } finally {
      if (append) setAuditsLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void loadJobs();
    void loadReviews();
    void loadAudits();
  }, [loadAudits, loadJobs, loadReviews]);

  useEffect(() => {
    if (tab !== "runs" || !highlightedJobId) return;
    const frame = requestAnimationFrame(() => {
      const row = jobRowRefs.current.get(highlightedJobId);
      if (!row) return;
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [highlightedJobId, jobs, tab]);

  const runCounts = useMemo(
    () => ({
      active: jobs.filter((job) => job.state === "queued" || job.state === "running").length,
      failed: jobs.filter((job) => job.state === "failed").length,
      complete: jobs.filter((job) => job.state === "succeeded").length,
    }),
    [jobs],
  );

  const refreshing =
    jobsStatus.loading || reviewsStatus.loading || auditsStatus.loading ||
    reviewsLoadingMore || auditsLoadingMore;

  async function refresh() {
    setNotice(null);
    await Promise.allSettled([loadJobs(), loadReviews(), loadAudits()]);
  }

  function markRetrying(jobId: string, busy: boolean) {
    setRetryingJobIds((current) => {
      const next = new Set(current);
      if (busy) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  }

  async function retry(job: UiJob) {
    markRetrying(job.id, true);
    setError(null);
    setNotice(null);
    try {
      await retryJob(job.id);
      setJobs((items) =>
        items.map((item) =>
          item.id === job.id ? { ...item, state: "queued", canRetry: false } : item,
        ),
      );
      setNotice(`${jobLabel(job.type)} retry queued.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      markRetrying(job.id, false);
    }
  }

  function markDecision(reviewId: string, state?: ReviewDecision) {
    setReviewDecisions((current) => {
      const next = { ...current };
      if (state) next[reviewId] = state;
      else delete next[reviewId];
      return next;
    });
  }

  async function decide(review: SourceReview, state: ReviewDecision) {
    markDecision(review.id, state);
    setError(null);
    setNotice(null);
    try {
      const note = reviewNotes[review.id]?.trim();
      await updateReview(review, state, note || undefined);
      setReviews((items) => items.filter((item) => item.id !== review.id));
      setReviewTotalCount((count) => Math.max(0, count - 1));
      setReviewOpenCount((count) => Math.max(0, count - 1));
      setReviewNotes((items) => {
        const next = { ...items };
        delete next[review.id];
        return next;
      });
      setNotice(
        state === "resolved"
          ? `Marked ${review.videoTitle ?? "the source"} as resolved.`
          : `Ignored ${review.videoTitle ?? "the source"}.`,
      );
    } catch (cause) {
      if (cause instanceof ActivityRequestError && cause.status === 409) {
        await loadReviews();
        setError(
          "This source changed while you were reviewing it. The latest evidence has been loaded; please review it again.",
        );
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      markDecision(review.id);
    }
  }

  function revealJob(review: SourceReview) {
    const relatedJobId = review.job?.id ?? review.jobId;
    setError(null);
    if (!relatedJobId || !jobs.some((job) => job.id === relatedJobId)) {
      setHighlightedJobId(null);
      setTab("runs");
      setNotice(
        relatedJobId
          ? `Related run ${relatedJobId.slice(0, 8)} is not available in the recent runs list.`
          : "This review no longer has a related run.",
      );
      return;
    }
    setHighlightedJobId(relatedJobId);
    setTab("runs");
    setNotice(`Showing related run ${relatedJobId.slice(0, 8)}.`);
  }

  function selectTab(nextTab: ActivityTab, focus = false) {
    setTab(nextTab);
    if (focus) tabRefs.current[nextTab]?.focus();
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: ActivityTab,
  ) {
    const currentIndex = TAB_ORDER.indexOf(currentTab);
    let nextTab: ActivityTab | null = null;
    if (event.key === "ArrowRight") {
      nextTab = TAB_ORDER[(currentIndex + 1) % TAB_ORDER.length];
    } else if (event.key === "ArrowLeft") {
      nextTab = TAB_ORDER[(currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length];
    } else if (event.key === "Home") {
      nextTab = TAB_ORDER[0];
    } else if (event.key === "End") {
      nextTab = TAB_ORDER.at(-1) ?? null;
    }
    if (!nextTab) return;
    event.preventDefault();
    selectTab(nextTab, true);
  }

  const tabs: Array<{
    id: ActivityTab;
    label: string;
    count: number | string;
    badge: "neutral" | "warning";
  }> = [
    {
      id: "runs",
      label: "Runs",
      count: jobsStatus.loaded ? jobs.length : "—",
      badge: "neutral",
    },
    {
      id: "reviews",
      label: "Review inbox",
      count: reviewsStatus.loaded ? reviewOpenCount : "—",
      badge: reviewOpenCount > 0 ? "warning" : "neutral",
    },
    {
      id: "history",
      label: "History",
      count: auditsStatus.loaded ? auditTotalCount : "—",
      badge: "neutral",
    },
  ];

  return (
    <>
      {(error || notice) && (
        <div
          className={cn(
            "mb-5 flex items-center gap-3 rounded-xl border px-4 py-3 text-xs",
            error
              ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
              : "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]",
          )}
          role={error ? "alert" : "status"}
        >
          <span className="flex-1 font-medium">{error ?? notice}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
            aria-label="Dismiss message"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-4 gap-4">
        <Card className="p-4 shadow-none">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">Active runs</p>
          <p className="mt-2 text-2xl font-bold tracking-[-0.04em]">{jobsStatus.loaded ? runCounts.active : "—"}</p>
        </Card>
        <Card className="p-4 shadow-none">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">Needs review</p>
          <p className="mt-2 text-2xl font-bold tracking-[-0.04em]">{reviewsStatus.loaded ? reviewOpenCount : "—"}</p>
        </Card>
        <Card className="p-4 shadow-none">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">Recent failures</p>
          <p className="mt-2 text-2xl font-bold tracking-[-0.04em]">{jobsStatus.loaded ? runCounts.failed : "—"}</p>
        </Card>
        <Card className="p-4 shadow-none">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">Recent completions</p>
          <p className="mt-2 text-2xl font-bold tracking-[-0.04em]">{jobsStatus.loaded ? runCounts.complete : "—"}</p>
        </Card>
      </div>

      <div className="mt-5 flex items-end justify-between border-b border-[var(--line)]">
        <div className="flex gap-6" role="tablist" aria-label="Activity views">
          {tabs.map((item) => (
            <button
              key={item.id}
              ref={(node) => {
                tabRefs.current[item.id] = node;
              }}
              id={`activity-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`activity-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => selectTab(item.id)}
              onKeyDown={(event) => handleTabKeyDown(event, item.id)}
              className={cn(
                "border-b-2 px-0.5 pb-3 text-xs font-bold outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                tab === item.id
                  ? "border-[var(--accent)] text-[var(--accent-strong)]"
                  : "border-transparent text-[var(--muted)]",
              )}
            >
              {item.label}
              <Badge variant={item.badge} className="ml-1.5">{item.count}</Badge>
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="mb-2"
        >
          <RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} /> Refresh
        </Button>
      </div>

      <section
        id="activity-panel-runs"
        role="tabpanel"
        aria-labelledby="activity-tab-runs"
        tabIndex={0}
        hidden={tab !== "runs"}
        className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
      >
        <Card className="mt-5 overflow-x-auto shadow-none">
          <div className="grid min-w-[68rem] grid-cols-[minmax(12rem,1.2fr)_8rem_minmax(12rem,1fr)_9rem_10rem_7rem] gap-4 border-b border-[var(--line)] bg-[var(--surface-subtle)] px-5 py-3 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">
            <span>Run</span>
            <span>State</span>
            <span>Progress</span>
            <span>Updated</span>
            <span>Result</span>
            <span className="text-right">Action</span>
          </div>
          {jobsStatus.loaded && jobsStatus.error ? <RefreshWarning message={jobsStatus.error} /> : null}
          {!jobsStatus.loaded && jobsStatus.loading ? (
            <LoadingState label="Loading background runs" />
          ) : !jobsStatus.loaded && jobsStatus.error ? (
            <FeedFailure
              title="Background runs could not be loaded"
              detail={jobsStatus.error}
              retrying={jobsStatus.loading}
              onRetry={() => void loadJobs()}
            />
          ) : jobs.length === 0 ? (
            <div className="grid min-h-52 place-items-center text-center">
              <div>
                <p className="text-sm font-bold">No background runs yet</p>
                <p className="mt-1 text-xs text-[var(--muted)]">Import a source or sync a monitored channel.</p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-[var(--line)]">
              {jobs.map((job) => {
                const progress = job.totalItems > 0
                  ? Math.round((job.completedItems / job.totalItems) * 100)
                  : job.state === "succeeded"
                    ? 100
                    : 0;
                const retrying = retryingJobIds.has(job.id);
                const highlighted = highlightedJobId === job.id;
                return (
                  <div
                    key={job.id}
                    ref={(node) => {
                      if (node) jobRowRefs.current.set(job.id, node);
                      else jobRowRefs.current.delete(job.id);
                    }}
                    tabIndex={-1}
                    aria-current={highlighted ? "true" : undefined}
                    className={cn(
                      "grid min-w-[68rem] grid-cols-[minmax(12rem,1.2fr)_8rem_minmax(12rem,1fr)_9rem_10rem_7rem] items-center gap-4 px-5 py-4 outline-none transition-colors",
                      highlighted && "bg-[var(--accent-soft)] ring-2 ring-inset ring-[var(--focus)]",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-bold">{jobLabel(job.type)}</p>
                      <p className="mt-0.5 truncate font-mono text-[9px] text-[var(--muted)]">{job.id}</p>
                    </div>
                    <div>{stateBadge(job.state)}</div>
                    <div>
                      <Progress value={progress} label={`${jobLabel(job.type)} progress`} />
                      <p className="mt-1 text-[9px] text-[var(--muted)]">
                        {job.state === "queued"
                          ? "Waiting for worker"
                          : job.totalItems > 0
                            ? `${job.completedItems} of ${job.totalItems} items`
                            : `${job.attempts} of ${job.maxAttempts} attempts`}
                      </p>
                    </div>
                    <p className="text-[10px] text-[var(--muted-strong)]">{dateTime(job.updatedAt)}</p>
                    <div>
                      {job.safeErrorSummary ? (
                        <p className="line-clamp-2 text-[9px] leading-4 text-[var(--danger)]" title={job.safeErrorSummary}>
                          {job.safeErrorSummary}
                        </p>
                      ) : (
                        <p className="text-[9px] text-[var(--muted)]">
                          {job.warningCount} warnings · {job.failureCount} failed items
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      {job.canRetry ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void retry(job)}
                          disabled={retrying}
                        >
                          {retrying ? <LoaderCircle className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                          {retrying ? "Queueing…" : "Retry"}
                        </Button>
                      ) : (
                        <span className="text-[9px] text-[var(--muted)]">—</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </section>

      <section
        id="activity-panel-reviews"
        role="tabpanel"
        aria-labelledby="activity-tab-reviews"
        tabIndex={0}
        hidden={tab !== "reviews"}
        className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
      >
        <Card className="mt-5 overflow-x-auto shadow-none">
          <div className="grid min-w-[72rem] grid-cols-[minmax(16rem,1.4fr)_11rem_8rem_minmax(14rem,1fr)_16rem] gap-4 border-b border-[var(--line)] bg-[var(--surface-subtle)] px-5 py-3 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">
            <span>Source</span>
            <span>Reason</span>
            <span>Evidence</span>
            <span>Diagnostics</span>
            <span className="text-right">Decision</span>
          </div>
          {reviewsStatus.loaded && reviewsStatus.error ? <RefreshWarning message={reviewsStatus.error} /> : null}
          {!reviewsStatus.loaded && reviewsStatus.loading ? (
            <LoadingState label="Loading source reviews" />
          ) : !reviewsStatus.loaded && reviewsStatus.error ? (
            <FeedFailure
              title="Source reviews could not be loaded"
              detail={reviewsStatus.error}
              retrying={reviewsStatus.loading}
              onRetry={() => void loadReviews()}
            />
          ) : reviews.length === 0 ? (
            <div className="grid min-h-52 place-items-center text-center">
              <div>
                <span className="mx-auto grid size-10 place-items-center rounded-xl bg-[var(--success-soft)] text-[var(--success)]">
                  <Check className="size-5" />
                </span>
                <p className="mt-4 text-sm font-bold">Review inbox is clear</p>
                <p className="mt-1 text-xs text-[var(--muted)]">Parser warnings and unavailable sources will appear here.</p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-[var(--line)]">
              {reviews.map((review) => {
                const decision = reviewDecisions[review.id];
                return (
                  <div
                    key={review.id}
                    className="grid min-w-[72rem] grid-cols-[minmax(16rem,1.4fr)_11rem_8rem_minmax(14rem,1fr)_16rem] items-center gap-4 px-5 py-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-bold">{review.videoTitle ?? "Untitled YouTube video"}</p>
                      <p className="mt-0.5 truncate text-[9px] text-[var(--muted)]">
                        {review.channelTitle} · updated {dateTime(review.updatedAt)}
                      </p>
                    </div>
                    <div>
                      <Badge variant={review.errorCount > 0 ? "danger" : "warning"}>
                        <FileWarning className="size-3" /> {reviewIssue(review)}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-xs font-bold">{review.mentionCount}</p>
                      <p className="text-[9px] text-[var(--muted)]">mentions kept</p>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[10px] text-[var(--muted-strong)]">
                        {review.rejectedRowCount} rejected rows · {review.ignoredLinkCount} ignored links
                      </p>
                      {review.job ? (
                        <button
                          type="button"
                          onClick={() => revealJob(review)}
                          className="mt-1 block max-w-full truncate font-mono text-[9px] font-semibold text-[var(--accent-strong)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                          title={`Reveal related ${jobLabel(review.job.type)} run ${review.job.id}`}
                        >
                          Run {review.job.id.slice(0, 8)} · {review.job.state}
                        </button>
                      ) : review.jobId ? (
                        <button
                          type="button"
                          onClick={() => revealJob(review)}
                          className="mt-1 block max-w-full truncate font-mono text-[9px] font-semibold text-[var(--accent-strong)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                        >
                          Find run {review.jobId.slice(0, 8)}
                        </button>
                      ) : null}
                      <a
                        href={`https://www.youtube.com/watch?v=${encodeURIComponent(review.youtubeVideoId)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-[9px] font-semibold text-[var(--accent-strong)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                      >
                        Inspect source <ExternalLink className="size-2.5" />
                      </a>
                    </div>
                    <div>
                      <input
                        aria-label={`Resolution note for ${review.videoTitle ?? "source review"}`}
                        value={reviewNotes[review.id] ?? ""}
                        onChange={(event) =>
                          setReviewNotes((items) => ({
                            ...items,
                            [review.id]: event.target.value,
                          }))
                        }
                        disabled={Boolean(decision)}
                        maxLength={2_000}
                        placeholder="Optional resolution note"
                        className="h-8 w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 text-[10px] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--focus)] disabled:opacity-50"
                      />
                      <div className="mt-2 flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void decide(review, "ignored")}
                          disabled={Boolean(decision)}
                        >
                          {decision === "ignored" ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                          {decision === "ignored" ? "Ignoring…" : "Ignore"}
                        </Button>
                        <Button
                          variant="accent"
                          size="sm"
                          onClick={() => void decide(review, "resolved")}
                          disabled={Boolean(decision)}
                        >
                          {decision === "resolved" ? <LoaderCircle className="size-3.5 animate-spin" /> : <ChevronRight className="size-3.5" />}
                          {decision === "resolved" ? "Resolving…" : "Resolve"}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {reviewsStatus.loaded && reviews.length > 0 ? (
            <div className="flex min-w-[72rem] items-center justify-center gap-3 border-t border-[var(--line)] px-5 py-4">
              {reviewsNextCursor ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadReviews(reviewsNextCursor)}
                  disabled={reviewsLoadingMore}
                >
                  {reviewsLoadingMore ? <LoaderCircle className="size-3.5 animate-spin" /> : <ChevronRight className="size-3.5" />}
                  {reviewsLoadingMore ? "Loading…" : "Load more reviews"}
                </Button>
              ) : null}
              <span className="text-[10px] text-[var(--muted)]">
                Showing {reviews.length} of {reviewTotalCount}
              </span>
            </div>
          ) : null}
        </Card>
      </section>

      <section
        id="activity-panel-history"
        role="tabpanel"
        aria-labelledby="activity-tab-history"
        tabIndex={0}
        hidden={tab !== "history"}
        className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
      >
        <Card className="mt-5 overflow-x-auto shadow-none">
          <div className="grid min-w-[64rem] grid-cols-[minmax(15rem,1.3fr)_8rem_minmax(14rem,1fr)_minmax(13rem,1fr)_10rem] gap-4 border-b border-[var(--line)] bg-[var(--surface-subtle)] px-5 py-3 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">
            <span>Operation</span>
            <span>Status</span>
            <span>Release</span>
            <span>Target</span>
            <span>Time</span>
          </div>
          {auditsStatus.loaded && auditsStatus.error ? <RefreshWarning message={auditsStatus.error} /> : null}
          {!auditsStatus.loaded && auditsStatus.loading ? (
            <LoadingState label="Loading activity history" />
          ) : !auditsStatus.loaded && auditsStatus.error ? (
            <FeedFailure
              title="Activity history could not be loaded"
              detail={auditsStatus.error}
              retrying={auditsStatus.loading}
              onRetry={() => void loadAudits()}
            />
          ) : auditEvents.length === 0 ? (
            <div className="grid min-h-52 place-items-center text-center">
              <div>
                <span className="mx-auto grid size-10 place-items-center rounded-xl bg-[var(--surface-subtle)] text-[var(--muted-strong)]">
                  <FileClock className="size-5" />
                </span>
                <p className="mt-4 text-sm font-bold">No local operations recorded yet</p>
                <p className="mt-1 text-xs text-[var(--muted)]">Updates, restores, and catalog changes appear here.</p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-[var(--line)]">
              {auditEvents.map((event) => (
                <div
                  key={event.id}
                  className="grid min-w-[64rem] grid-cols-[minmax(15rem,1.3fr)_8rem_minmax(14rem,1fr)_minmax(13rem,1fr)_10rem] items-center gap-4 px-5 py-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold capitalize">{auditLabel(event.action)}</p>
                    <p className="mt-0.5 truncate font-mono text-[9px] text-[var(--muted)]">event {event.id}</p>
                  </div>
                  <div>
                    <Badge
                      variant={event.status === "failed" ? "danger" : event.status === "succeeded" ? "success" : "neutral"}
                    >
                      {event.status}
                    </Badge>
                  </div>
                  <p className="truncate font-mono text-[10px] text-[var(--muted-strong)]">
                    {event.beforeRelease && event.afterRelease
                      ? `${event.beforeRelease} → ${event.afterRelease}`
                      : event.afterRelease ?? "—"}
                  </p>
                  <div className="min-w-0">
                    <p className="truncate text-[10px] font-semibold">{event.targetType.replaceAll("_", " ")}</p>
                    <p className="truncate font-mono text-[9px] text-[var(--muted)]" title={event.targetId}>{event.targetId}</p>
                  </div>
                  <p className="text-[10px] text-[var(--muted-strong)]">{dateTime(event.createdAt)}</p>
                </div>
              ))}
            </div>
          )}
          {auditsStatus.loaded && auditEvents.length > 0 ? (
            <div className="flex min-w-[64rem] items-center justify-center gap-3 border-t border-[var(--line)] px-5 py-4">
              {auditsNextCursor ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadAudits(auditsNextCursor)}
                  disabled={auditsLoadingMore}
                >
                  {auditsLoadingMore ? <LoaderCircle className="size-3.5 animate-spin" /> : <ChevronRight className="size-3.5" />}
                  {auditsLoadingMore ? "Loading…" : "Load more history"}
                </Button>
              ) : null}
              <span className="text-[10px] text-[var(--muted)]">
                Showing {auditEvents.length} of {auditTotalCount}
              </span>
            </div>
          ) : null}
        </Card>
      </section>
    </>
  );
}
