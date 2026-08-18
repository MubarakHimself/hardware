"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Clock3,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  X,
  Youtube,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { errorMessage, retryJob, syncChannel } from "@/lib/client/api";

type SyncFrequency = "manual" | "daily" | "weekly";
type HistoryMode = "latest_10" | "latest_25" | "latest_50" | "since" | "all";

interface ChannelRow {
  id: string;
  name: string;
  handle: string;
  status: "healthy" | "syncing" | "attention";
  videos: number;
  projects: number;
  progress: number | null;
  progressLabel: string | null;
  warnings: number;
  failures: number;
  lastSync: string;
  nextSync: string;
  retryableJobId: string | null;
  paused: boolean;
  syncFrequency: SyncFrequency;
  historyMode: HistoryMode;
  historySince: string | null;
}

interface ApiEnvelope<T> {
  data: T;
  detail?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function dateLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value) return fallback;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const delta = time - Date.now();
  const past = delta < 0;
  const minutes = Math.max(0, Math.round(Math.abs(delta) / 60_000));
  if (minutes < 1) return past ? "just now" : "due now";
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return past ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return past ? `${days}d ago` : `in ${days}d`;
}

function localCalendarDateToUtc(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const boundary = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    boundary.getFullYear() !== year ||
    boundary.getMonth() !== month - 1 ||
    boundary.getDate() !== day
  ) {
    throw new Error("Choose a valid local calendar date.");
  }
  return boundary.toISOString();
}

function normalizeChannel(value: unknown): ChannelRow {
  const source = record(value);
  const status = source.status;
  const frequency = source.syncFrequency ?? source.sync_frequency;
  const historyMode = source.initialHistoryMode ?? source.initial_history_mode;
  return {
    id: String(source.id ?? ""),
    name: String(source.title ?? source.name ?? "Untitled channel"),
    handle: String(source.handle ?? ""),
    status:
      status === "syncing" || status === "attention" ? status : "healthy",
    videos: Number(source.videoCount ?? source.videos ?? 0),
    projects: Number(source.projectCount ?? source.projects ?? 0),
    progress:
      typeof source.progress === "number" ? source.progress : source.progress === null ? null : Number(source.progress) || null,
    progressLabel:
      typeof (source.progressLabel ?? source.progress_label) === "string"
        ? String(source.progressLabel ?? source.progress_label)
        : null,
    warnings: Number(source.warningCount ?? source.warnings ?? 0),
    failures: Number(source.failureCount ?? source.failures ?? 0),
    lastSync: dateLabel(
      source.lastSyncedAt ?? source.last_sync ?? source.lastSync,
      "Not synced",
    ),
    nextSync:
      frequency === "manual"
        ? "Manual"
        : dateLabel(source.nextSyncAt ?? source.next_sync ?? source.nextSync, "After first run"),
    retryableJobId:
      typeof (source.retryableJobId ?? source.retryable_job_id) === "string"
        ? String(source.retryableJobId ?? source.retryable_job_id)
        : null,
    paused: source.paused === true,
    syncFrequency:
      frequency === "manual" || frequency === "weekly" ? frequency : "daily",
    historyMode:
      historyMode === "latest_10" ||
      historyMode === "latest_50" ||
      historyMode === "since" ||
      historyMode === "all"
        ? historyMode
        : "latest_25",
    historySince:
      typeof (source.initialHistorySince ?? source.initial_history_since) === "string"
        ? String(source.initialHistorySince ?? source.initial_history_since)
        : null,
  };
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
  if (!response.ok) throw new Error(payload.detail || "The source request failed.");
  return payload.data;
}

async function listChannelRows(): Promise<ChannelRow[]> {
  const values = await request<unknown[]>("/api/channels");
  return Array.isArray(values) ? values.map(normalizeChannel) : [];
}

async function createChannel(input: {
  url: string;
  syncFrequency: SyncFrequency;
  initialHistory:
    | { mode: Exclude<HistoryMode, "since"> }
    | { mode: "since"; since: string };
}): Promise<ChannelRow> {
  const result = await request<unknown>("/api/channels", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const payload = record(result);
  return normalizeChannel(payload.channel ?? payload);
}

async function updateChannel(
  id: string,
  input: { paused?: boolean; syncFrequency?: SyncFrequency },
): Promise<{ nextSyncAt: string | null }> {
  return request<{ nextSyncAt: string | null }>(`/api/channels/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function historyLabel(channel: ChannelRow): string {
  if (channel.historyMode === "all") return "All available videos";
  if (channel.historyMode === "since") {
    return channel.historySince
      ? `Since ${new Date(channel.historySince).toLocaleDateString()}`
      : "Since chosen date";
  }
  return `Latest ${channel.historyMode.split("_")[1]} videos`;
}

export function ChannelsClient() {
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [frequency, setFrequency] = useState<SyncFrequency>("daily");
  const [historyMode, setHistoryMode] = useState<HistoryMode>("latest_25");
  const [historySince, setHistorySince] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeCount = useMemo(
    () => channels.filter((channel) => !channel.paused).length,
    [channels],
  );

  useEffect(() => {
    let active = true;
    listChannelRows()
      .then((rows) => {
        if (active) setChannels(rows);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setChannels(await listChannelRows());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  async function submitChannel(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || (historyMode === "since" && !historySince)) return;
    setSubmitting(true);
    setError(null);
    try {
      const initialHistory =
        historyMode === "since"
          ? {
              mode: "since" as const,
              since: localCalendarDateToUtc(historySince),
            }
          : { mode: historyMode };
      const channel = await createChannel({
        url: url.trim(),
        syncFrequency: frequency,
        initialHistory,
      });
      setChannels((items) => [
        channel,
        ...items.filter((item) => item.id !== channel.id),
      ]);
      setUrl("");
      setFrequency("daily");
      setHistoryMode("latest_25");
      setHistorySince("");
      setOpen(false);
      setNotice("Source monitoring started and the selected history was queued.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function runChannel(channel: ChannelRow) {
    setBusyId(channel.id);
    setError(null);
    try {
      if (channel.retryableJobId) await retryJob(channel.retryableJobId);
      else await syncChannel(channel.id);
      setChannels((items) =>
        items.map((item) =>
          item.id === channel.id
            ? {
                ...item,
                status: "syncing",
                progress: 0,
                progressLabel: channel.retryableJobId ? "Retry queued" : "Sync queued",
                lastSync: "just now",
              }
            : item,
        ),
      );
      setNotice(
        channel.retryableJobId
          ? `Retry queued for ${channel.name}.`
          : `Sync queued for ${channel.name}.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function setSchedule(channel: ChannelRow, next: SyncFrequency) {
    if (next === channel.syncFrequency) return;
    setBusyId(channel.id);
    setError(null);
    try {
      const updated = await updateChannel(channel.id, { syncFrequency: next });
      setChannels((items) =>
        items.map((item) =>
          item.id === channel.id
            ? {
                ...item,
                syncFrequency: next,
                nextSync:
                  next === "manual"
                    ? "Manual"
                    : dateLabel(updated.nextSyncAt, "After first run"),
              }
            : item,
        ),
      );
      setNotice(`${channel.name} now syncs ${next}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function togglePaused(channel: ChannelRow) {
    setBusyId(channel.id);
    setError(null);
    try {
      await updateChannel(channel.id, { paused: !channel.paused });
      setChannels((items) =>
        items.map((item) =>
          item.id === channel.id ? { ...item, paused: !item.paused } : item,
        ),
      );
      setNotice(
        channel.paused
          ? `${channel.name} monitoring resumed.`
          : `${channel.name} monitoring paused.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {(error || notice) && (
        <div
          className={`mb-5 flex items-center gap-3 rounded-xl border px-4 py-3 text-xs ${
            error
              ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
              : "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"
          }`}
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

      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <Badge variant="accent">Personal</Badge>
          <span>{activeCount} monitored · automatic runs catch up after this app restarts</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
            Refresh
          </Button>
          <Button variant="accent" size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-3.5" /> Add source
          </Button>
        </div>
      </div>

      <Card className="overflow-x-auto shadow-none">
        <div className="grid min-w-[72rem] grid-cols-[minmax(15rem,1.35fr)_8rem_9rem_minmax(13rem,1fr)_8rem_11rem] gap-4 border-b border-[var(--line)] bg-[var(--surface-subtle)] px-5 py-3 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">
          <span>Source</span>
          <span>Schedule</span>
          <span>Library</span>
          <span>Run state</span>
          <span>Next run</span>
          <span className="text-right">Actions</span>
        </div>
        {loading ? (
          <div className="grid min-h-48 place-items-center text-xs text-[var(--muted)]">
            <LoaderCircle className="mb-2 size-5 animate-spin" />
          </div>
        ) : channels.length === 0 ? (
          <div className="grid min-h-52 place-items-center px-6 py-10 text-center">
            <div>
              <span className="mx-auto grid size-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
                <Youtube className="size-5" />
              </span>
              <p className="mt-4 text-sm font-bold">No monitored channels yet</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Add one source and choose how much history Hardware should inspect.
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-[var(--line)]">
            {channels.map((channel) => (
              <div
                key={channel.id}
                className="grid min-w-[72rem] grid-cols-[minmax(15rem,1.35fr)_8rem_9rem_minmax(13rem,1fr)_8rem_11rem] items-center gap-4 px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--danger-soft)] text-[var(--youtube)]">
                      <Youtube className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-bold">{channel.name}</span>
                      <span className="block truncate text-[10px] text-[var(--muted)]">
                        {channel.handle || "YouTube channel"} · {historyLabel(channel)}
                      </span>
                    </span>
                  </div>
                </div>
                <select
                  aria-label={`Sync schedule for ${channel.name}`}
                  value={channel.syncFrequency}
                  onChange={(event) => setSchedule(channel, event.target.value as SyncFrequency)}
                  disabled={busyId === channel.id || channel.paused}
                  className="h-8 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 text-[10px] font-semibold capitalize outline-none focus:border-[var(--accent)]"
                >
                  <option value="manual">Manual</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
                <div>
                  <p className="text-xs font-bold">{channel.projects.toLocaleString()} projects</p>
                  <p className="mt-0.5 text-[9px] text-[var(--muted)]">
                    {channel.videos.toLocaleString()} videos inspected
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    {channel.paused ? (
                      <Badge>Paused</Badge>
                    ) : channel.status === "healthy" ? (
                      <Badge variant="success"><Check className="size-3" /> Ready</Badge>
                    ) : channel.status === "syncing" ? (
                      <Badge variant="accent"><Clock3 className="size-3" /> Running</Badge>
                    ) : (
                      <Badge variant="warning"><AlertTriangle className="size-3" /> Attention</Badge>
                    )}
                    <span className="text-[9px] text-[var(--muted)]">{channel.lastSync}</span>
                  </div>
                  {channel.status === "syncing" && channel.progress !== null ? (
                    <div className="mt-2">
                      <Progress value={channel.progress} label={`${channel.name} sync progress`} />
                      <p className="mt-1 text-[9px] text-[var(--muted)]">
                        {channel.progressLabel ?? `${channel.progress}% complete`}
                      </p>
                    </div>
                  ) : channel.warnings + channel.failures > 0 ? (
                    <p className="mt-1 text-[9px] text-[var(--warning)]">
                      {channel.warnings} warnings · {channel.failures} failed items
                    </p>
                  ) : (
                    <p className="mt-1 text-[9px] text-[var(--muted)]">No unresolved run warnings</p>
                  )}
                </div>
                <span className="text-[10px] font-semibold text-[var(--muted-strong)]">
                  {channel.paused ? "Paused" : channel.nextSync}
                </span>
                <div className="flex justify-end gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() => togglePaused(channel)}
                    disabled={busyId === channel.id}
                    aria-label={channel.paused ? `Resume ${channel.name}` : `Pause ${channel.name}`}
                    title={channel.paused ? "Resume" : "Pause"}
                  >
                    {channel.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                  </Button>
                  <Button
                    variant={channel.retryableJobId ? "danger" : "secondary"}
                    size="sm"
                    onClick={() => runChannel(channel)}
                    disabled={busyId === channel.id}
                  >
                    {busyId === channel.id ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : channel.retryableJobId ? (
                      <RotateCcw className="size-3.5" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    {channel.retryableJobId ? "Retry" : "Sync now"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-5 grid grid-cols-3 gap-4">
        <Card className="p-4 shadow-none">
          <CalendarClock className="size-4 text-[var(--accent-strong)]" />
          <p className="mt-3 text-[10px] font-semibold text-[var(--muted)]">Schedule choices</p>
          <p className="mt-1 text-sm font-bold">Manual · Daily · Weekly</p>
          <p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">
            A missed automatic run becomes one catch-up run after startup.
          </p>
        </Card>
        <Card className="p-4 shadow-none">
          <Clock3 className="size-4 text-[var(--accent-strong)]" />
          <p className="mt-3 text-[10px] font-semibold text-[var(--muted)]">Serialized work</p>
          <p className="mt-1 text-sm font-bold">One active run per source</p>
          <p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">
            Sync now and automatic work reuse the active channel run.
          </p>
        </Card>
        <Card className="p-4 shadow-none">
          <RotateCcw className="size-4 text-[var(--accent-strong)]" />
          <p className="mt-3 text-[10px] font-semibold text-[var(--muted)]">Recovery</p>
          <p className="mt-1 text-sm font-bold">Retry only failed work</p>
          <p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">
            Successful video imports are not replayed when one item fails.
          </p>
        </Card>
      </div>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-[var(--backdrop)] backdrop-blur-[2px]" />
          <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-8">
            <Dialog.Popup className="w-[680px] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-2xl outline-none">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <Dialog.Title className="text-xl font-bold tracking-[-0.03em]">
                    Monitor a YouTube channel
                  </Dialog.Title>
                  <Dialog.Description className="mt-1.5 text-sm leading-6 text-[var(--muted-strong)]">
                    Choose the initial history once. Future runs follow the schedule below and read descriptions through the official API.
                  </Dialog.Description>
                </div>
                <Dialog.Close
                  className={buttonVariants({ variant: "ghost", size: "icon" })}
                  aria-label="Close"
                >
                  <X className="size-4" />
                </Dialog.Close>
              </div>
              <form onSubmit={submitChannel} className="mt-6">
                <label className="block text-xs font-semibold" htmlFor="channel-url">
                  Channel URL or @handle
                </label>
                <Input
                  id="channel-url"
                  className="mt-2"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://youtube.com/@channel"
                  autoFocus
                  required
                />
                <div className="mt-5 grid grid-cols-2 gap-4">
                  <label className="block text-xs font-semibold">
                    Sync schedule
                    <select
                      className="mt-2 h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-xs outline-none focus:border-[var(--accent)]"
                      value={frequency}
                      onChange={(event) => setFrequency(event.target.value as SyncFrequency)}
                    >
                      <option value="manual">Manual</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </label>
                  <label className="block text-xs font-semibold">
                    Initial history
                    <select
                      className="mt-2 h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-xs outline-none focus:border-[var(--accent)]"
                      value={historyMode}
                      onChange={(event) => setHistoryMode(event.target.value as HistoryMode)}
                    >
                      <option value="latest_10">Latest 10 videos</option>
                      <option value="latest_25">Latest 25 videos</option>
                      <option value="latest_50">Latest 50 videos</option>
                      <option value="since">Videos since a date</option>
                      <option value="all">All available videos</option>
                    </select>
                  </label>
                </div>
                {historyMode === "since" && (
                  <label className="mt-4 block text-xs font-semibold">
                    Start date
                    <Input
                      className="mt-2 w-64"
                      type="date"
                      value={historySince}
                      onChange={(event) => setHistorySince(event.target.value)}
                      required
                    />
                  </label>
                )}
                <div className="mt-5 rounded-xl border border-[var(--accent-line)] bg-[var(--accent-soft)] p-3 text-[10px] leading-4 text-[var(--muted-strong)]">
                  Hardware stores metadata and source evidence only. It does not download video, audio, captions, frames, or transcripts.
                </div>
                <div className="mt-6 flex justify-end gap-2">
                  <Dialog.Close className={buttonVariants({ variant: "secondary" })}>
                    Cancel
                  </Dialog.Close>
                  <Button variant="accent" type="submit" disabled={submitting}>
                    {submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                    {submitting ? "Adding…" : "Start monitoring"}
                  </Button>
                </div>
              </form>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
