"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  Activity,
  Archive,
  BookOpen,
  Check,
  CircleAlert,
  Command,
  FolderKanban,
  Import,
  LoaderCircle,
  Monitor,
  Moon,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sun,
  X,
  Youtube,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTheme } from "@/components/hardware/theme-provider";
import { DesktopOnboarding } from "@/components/hardware/desktop-onboarding";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addChannel, errorMessage, queueImport } from "@/lib/client/api";
import type { UiJob } from "@/lib/client/contracts";
import { cn } from "@/lib/utils";

const navigation = [
  { href: "/radar", label: "Radar", icon: RadioTower },
  { href: "/inventory", label: "Library", icon: Archive },
  { href: "/channels", label: "Sources", icon: Youtube },
  { href: "/collections", label: "Collections", icon: FolderKanban },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings2 },
] as const;

type RuntimeMode = "demo" | "local";

type ImportKind =
  | "youtube_video"
  | "youtube_channel"
  | "website"
  | "github_repository";

interface PreviewRow {
  ordinal: number;
  input: string;
  normalizedUrl: string | null;
  kind: ImportKind | null;
  duplicateOf: number | null;
  error: string | null;
  state: "ready" | "duplicate" | "invalid";
}

interface ServerPreviewRow {
  ordinal: number;
  kind: ImportKind | null;
  originalUrl: string | null;
  normalizedUrl: string | null;
  state: "ready" | "duplicate" | "invalid";
  duplicateOfOrdinal: number | null;
  validationCode: string | null;
  validationSummary: string | null;
}

interface ImportBatchItem {
  id: string;
  ordinal: number;
  kind: ImportKind | null;
  originalUrl: string | null;
  normalizedUrl: string | null;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "duplicate"
    | "invalid";
  validationCode: string | null;
  validationSummary: string | null;
  duplicateOfItemId: string | null;
  jobId: string | null;
  jobState: "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;
  retryCount: number;
}

interface ImportBatchResponse {
  id: string;
  state: "processing" | "queued" | "succeeded" | "partial" | "failed";
  totalItems: number;
  queuedItems: number;
  duplicateItems: number;
  invalidItems: number;
  correlationId: string;
  createdAt: string;
  items: ImportBatchItem[];
}

interface LocalSummaryItem {
  ordinal: number;
  input: string;
  label: string;
  state: "queued" | "duplicate" | "failed";
  error: string | null;
}

interface ImportSummary {
  batch: ImportBatchResponse | null;
  batchOrdinals: number[];
  items: LocalSummaryItem[];
  jobs: UiJob[];
}

const unsupportedSocialHosts = new Map([
  ["instagram.com", "Instagram"],
  ["tiktok.com", "TikTok"],
  ["facebook.com", "Facebook"],
  ["fb.watch", "Facebook Watch"],
  ["x.com", "X"],
  ["twitter.com", "X"],
  ["vimeo.com", "Vimeo"],
  ["dailymotion.com", "Dailymotion"],
  ["twitch.tv", "Twitch"],
]);

function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {navigation.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              active
                ? "bg-white/11 text-white"
                : "text-white/60 hover:bg-white/7 hover:text-white",
            )}
          >
            <Icon
              className={cn(
                "size-4",
                active ? "text-[var(--sidebar-accent)]" : "text-white/42",
              )}
            />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarContent({ mode }: { mode: RuntimeMode }) {
  return (
    <>
      <div className="flex h-18 items-center gap-3 border-b border-white/8 px-5">
        <div className="grid size-8 place-items-center rounded-lg bg-[var(--sidebar-accent)] text-sm font-black tracking-[-0.04em] text-[#16231d]">
          HW
        </div>
        <div>
          <p className="text-sm font-bold tracking-[-0.01em] text-white">
            Hardware
          </p>
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-white/35">
            Personal project index
          </p>
        </div>
      </div>

      <div className="flex-1 px-3 py-5">
        <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">
          Library
        </p>
        <NavLinks />

        <div className="mt-7 rounded-xl border border-white/8 bg-white/[0.035] p-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-xs font-semibold text-white/76">
              <span className="size-1.5 rounded-full bg-[var(--sidebar-accent)] shadow-[0_0_0_3px_rgb(139_221_183_/_0.12)]" />
              {mode === "local" ? "Local engine" : "Demo engine"}
            </span>
            <Badge className="border-white/10 bg-white/6 text-white/50">
              {mode === "local" ? "private" : "sample"}
            </Badge>
          </div>
          <p className="mt-3 text-[10px] leading-4 text-white/38">
            Scheduled sources catch up the next time Hardware is running.
          </p>
        </div>
      </div>

      <div className="border-t border-white/8 p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <span className="grid size-8 place-items-center rounded-full bg-white/10 text-white/64">
            <Monitor className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-white">
              {mode === "local" ? "This computer" : "Demo data"}
            </span>
            <span className="block truncate text-[10px] text-white/38">
              {mode === "local"
                ? "Database and backups stay local"
                : "Changes reset with the demo"}
            </span>
          </span>
        </div>
      </div>
    </>
  );
}

function detectImport(value: string): {
  kind: ImportKind;
  normalizedUrl: string;
} {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Only HTTP(S) links are supported.");
  }
  parsed.hash = "";
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean);

  for (const [domain, provider] of unsupportedSocialHosts) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      throw new TypeError(
        `${provider} and other social-video providers are out of scope in Personal Local v1.1.`,
      );
    }
  }

  if (host === "youtu.be") {
    if (!segments[0]) throw new TypeError("The YouTube link has no video ID.");
    return {
      kind: "youtube_video",
      normalizedUrl: `https://www.youtube.com/watch?v=${segments[0]}`,
    };
  }

  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const videoId =
      parsed.searchParams.get("v") ??
      (["shorts", "live", "embed"].includes(segments[0] ?? "")
        ? segments[1]
        : null);
    if (videoId) {
      return {
        kind: "youtube_video",
        normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
      };
    }
    if (
      segments[0]?.startsWith("@") ||
      ["channel", "c", "user"].includes(segments[0] ?? "")
    ) {
      return { kind: "youtube_channel", normalizedUrl: parsed.toString() };
    }
    throw new TypeError("Use a YouTube video or channel link.");
  }

  if (host === "github.com" && segments.length >= 2) {
    return {
      kind: "github_repository",
      normalizedUrl: `https://github.com/${segments[0]}/${segments[1].replace(/\.git$/i, "")}`,
    };
  }

  return { kind: "website", normalizedUrl: parsed.toString() };
}

function physicalLines(input: string) {
  return input
    .split(/\r?\n/)
    .map((source, index) => ({ ordinal: index + 1, input: source.trim() }))
    .filter((row) => row.input && !row.input.startsWith("#"));
}

async function previewLines(
  input: string,
  signal?: AbortSignal,
): Promise<PreviewRow[]> {
  const detectedRows = physicalLines(input).map((row) => {
    try {
      return { ...row, ...detectImport(row.input), error: null };
    } catch (cause) {
      return {
        ...row,
        normalizedUrl: null,
        kind: null,
        error:
          cause instanceof Error ? cause.message : "This link is not supported.",
      };
    }
  });
  const serverInputRows = detectedRows.filter(
    (row): row is typeof row & {
      kind: ImportKind;
      normalizedUrl: string;
      error: null;
    } => !row.error && Boolean(row.kind),
  );

  let serverRows: ServerPreviewRow[] = [];
  if (serverInputRows.length > 0) {
    const response = await fetch("/api/import-batches/preview", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        items: serverInputRows.map((row) => ({ kind: row.kind, url: row.input })),
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      data?: ServerPreviewRow[];
      detail?: string;
    };
    if (!response.ok || !Array.isArray(payload.data)) {
      throw new Error(payload.detail || "The import preview could not be checked.");
    }
    serverRows = payload.data;
  }

  const serverIndexByOrdinal = new Map(
    serverInputRows.map((row, index) => [row.ordinal, index]),
  );

  return detectedRows.map((row): PreviewRow => {
    if (row.error || !row.kind || !row.normalizedUrl) {
      return {
        ...row,
        kind: null,
        duplicateOf: null,
        state: "invalid",
      };
    }
    const serverIndex = serverIndexByOrdinal.get(row.ordinal);
    const serverRow =
      serverIndex === undefined ? undefined : serverRows[serverIndex];
    if (!serverRow) {
      return {
        ...row,
        duplicateOf: null,
        error: "The server did not return a preview for this row.",
        state: "invalid",
      };
    }
    const duplicateOf = serverRow.duplicateOfOrdinal
      ? (serverInputRows[serverRow.duplicateOfOrdinal - 1]?.ordinal ?? null)
      : null;
    return {
      ordinal: row.ordinal,
      input: row.input,
      normalizedUrl: serverRow.normalizedUrl,
      kind: serverRow.kind,
      duplicateOf,
      error: serverRow.validationSummary,
      state: serverRow.state,
    };
  });
}

function kindLabel(kind: ImportKind | null): string {
  if (kind === "youtube_video") return "YouTube video · one-off";
  if (kind === "youtube_channel") return "YouTube channel · monitored";
  if (kind === "github_repository") return "GitHub repository";
  if (kind === "website") return "Website";
  return "Invalid";
}

async function queueRow(row: PreviewRow): Promise<UiJob | null> {
  if (!row.kind || !row.normalizedUrl) {
    throw new Error("The row is not ready to import.");
  }
  if (row.kind === "youtube_channel") {
    await addChannel(row.normalizedUrl);
    return null;
  }
  return queueImport(row.normalizedUrl, row.kind);
}

async function queueBatch(rows: PreviewRow[]): Promise<ImportBatchResponse> {
  const response = await fetch("/api/import-batches", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": `ui-bulk:${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      items: rows.map((row) => ({ kind: row.kind, url: row.input })),
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: ImportBatchResponse;
    detail?: string;
  };
  if (!response.ok || !payload.data) {
    throw new Error(payload.detail || "The bulk import could not be queued.");
  }
  return payload.data;
}

async function getBatch(batchId: string): Promise<ImportBatchResponse> {
  const response = await fetch(`/api/import-batches/${encodeURIComponent(batchId)}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: ImportBatchResponse;
    detail?: string;
  };
  if (!response.ok || !payload.data) {
    throw new Error(payload.detail || "The import batch could not be refreshed.");
  }
  return payload.data;
}

async function retryBatchItem(batchId: string, itemId: string): Promise<void> {
  const response = await fetch(
    `/api/import-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/retry`,
    {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    },
  );
  const payload = (await response.json().catch(() => ({}))) as {
    detail?: string;
  };
  if (!response.ok) {
    throw new Error(payload.detail || "The failed row could not be retried.");
  }
}

function ImportDialog({
  open,
  onOpenChange,
  onViewActivity,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewActivity: () => void;
}) {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [singleValue, setSingleValue] = useState("");
  const [bulkValue, setBulkValue] = useState("");
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const validRows = rows.filter(
    (row) => row.state === "ready",
  );
  const summaryCounts = summary
    ? {
        accepted:
          summary.items.filter((item) => item.state !== "failed").length +
          (summary.batch?.items.filter(
            (item) =>
              item.state === "duplicate" ||
              item.state === "succeeded" ||
              ((item.state === "queued" || item.state === "running") &&
                item.jobState !== "failed" &&
                item.jobState !== "cancelled"),
          ).length ?? 0),
        failed:
          summary.items.filter((item) => item.state === "failed").length +
          (summary.batch?.items.filter(
            (item) =>
              item.state === "invalid" ||
              item.state === "failed" ||
              item.state === "cancelled" ||
              item.jobState === "failed" ||
              item.jobState === "cancelled",
          ).length ?? 0),
      }
    : null;

  useEffect(() => {
    if (physicalLines(bulkValue).length === 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      previewLines(bulkValue, controller.signal)
        .then((nextRows) => {
          if (controller.signal.aborted) return;
          setRows(nextRows);
          setPreviewError(null);
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setRows([]);
          setPreviewError(errorMessage(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewing(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [bulkValue]);

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen) {
      setMode("single");
      setSingleValue("");
      setBulkValue("");
      setRows([]);
      setPreviewing(false);
      setPreviewError(null);
      setSummary(null);
      setBusy(false);
      setBusyItemId(null);
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  async function submitSingle(event: FormEvent) {
    event.preventDefault();
    if (!singleValue.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const detected = detectImport(singleValue.trim());
      const job = await queueRow({
        ordinal: 1,
        input: singleValue.trim(),
        normalizedUrl: detected.normalizedUrl,
        kind: detected.kind,
        duplicateOf: null,
        error: null,
        state: "ready",
      });
      setSummary({
        batch: null,
        batchOrdinals: [],
        items: [
          {
            ordinal: 1,
            input: singleValue.trim(),
            label: kindLabel(detected.kind),
            state: "queued",
            error: null,
          },
        ],
        jobs: job ? [job] : [],
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitBulk(event: FormEvent) {
    event.preventDefault();
    if (previewing || previewError || !validRows.length) return;
    if (rows.length > 500) {
      setError("A bulk import can contain at most 500 non-comment rows.");
      return;
    }
    setBusy(true);
    setError(null);
    const batchResult = await queueBatch(rows).catch((cause) => ({ cause }));
    const failedBatchItems: LocalSummaryItem[] =
      "cause" in batchResult
        ? rows.map((row) => ({
            ordinal: row.ordinal,
            input: row.input,
            label: kindLabel(row.kind),
            state: "failed" as const,
            error: errorMessage(batchResult.cause),
          }))
        : [];
    const batch = "cause" in batchResult ? null : batchResult;
    setSummary({
      batch,
      batchOrdinals: rows.map((row) => row.ordinal),
      items: failedBatchItems,
      jobs: [],
    });
    if (batch?.invalidItems || failedBatchItems.length) {
      setError("Some rows need attention. Successful rows were kept.");
    }
    setBusy(false);
  }

  async function refreshBatch() {
    if (!summary?.batch) return;
    setBusy(true);
    setError(null);
    try {
      const batch = await getBatch(summary.batch.id);
      setSummary((current) => (current ? { ...current, batch } : current));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function retryItem(item: ImportBatchItem) {
    if (!summary?.batch) return;
    setBusyItemId(item.id);
    setError(null);
    try {
      await retryBatchItem(summary.batch.id, item.id);
      const batch = await getBatch(summary.batch.id);
      setSummary((current) => (current ? { ...current, batch } : current));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyItemId(null);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-[var(--backdrop)] backdrop-blur-[2px]" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-8">
          <Dialog.Popup className="relative w-[760px] rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-2xl outline-none">
            <div className="flex items-start justify-between gap-6 border-b border-[var(--line)] px-6 py-5">
              <div>
                <div className="mb-3 grid size-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
                  <Import className="size-5" />
                </div>
                <Dialog.Title className="text-xl font-bold tracking-[-0.025em] text-[var(--ink)]">
                  Import sources
                </Dialog.Title>
                <Dialog.Description className="mt-1.5 text-sm leading-6 text-[var(--muted-strong)]">
                  Capture one link or queue a clean multiline batch. Video imports stay one-off; channel links become monitored sources.
                </Dialog.Description>
              </div>
              <Dialog.Close
                className={buttonVariants({ variant: "ghost", size: "icon" })}
                aria-label="Close import"
              >
                <X className="size-4" />
              </Dialog.Close>
            </div>

            <div className="border-b border-[var(--line)] px-6 pt-4">
              <div className="flex gap-6" role="tablist" aria-label="Import mode">
                {(["single", "bulk"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={mode === item}
                    onClick={() => {
                      setMode(item);
                      setSummary(null);
                      setError(null);
                    }}
                    className={cn(
                      "border-b-2 px-0.5 pb-3 text-xs font-bold capitalize outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                      mode === item
                        ? "border-[var(--accent)] text-[var(--accent-strong)]"
                        : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]",
                    )}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            {summary ? (
              <div className="p-6">
                <div
                  className={cn(
                    "rounded-xl border p-5",
                    summaryCounts?.failed
                      ? "border-[var(--warning-line)] bg-[var(--warning-soft)]"
                      : "border-[var(--success-line)] bg-[var(--success-soft)]",
                  )}
                  role="status"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "grid size-8 place-items-center rounded-full bg-[var(--surface)]",
                        summaryCounts?.failed
                          ? "text-[var(--warning)]"
                          : "text-[var(--success)]",
                      )}
                    >
                      {summaryCounts?.failed ? (
                        <CircleAlert className="size-4" />
                      ) : (
                        <Check className="size-4" />
                      )}
                    </span>
                    <div>
                      <p className="text-sm font-bold text-[var(--ink)]">
                        {summaryCounts?.accepted ?? 0}{" "}
                        {(summaryCounts?.accepted ?? 0) === 1 ? "source" : "sources"} accepted
                        {summaryCounts?.failed
                          ? ` · ${summaryCounts.failed} need attention`
                          : ""}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-[var(--muted-strong)]">
                        Background work continues while Hardware is running. You can close this window safely.
                      </p>
                    </div>
                  </div>
                  {summary.jobs.length > 0 && (
                    <p className="mt-4 font-mono text-[9px] text-[var(--muted)]">
                      {summary.jobs.length} tracked {summary.jobs.length === 1 ? "job" : "jobs"}
                    </p>
                  )}
                </div>

                {(summary.batch || summary.items.length > 0) && (
                  <div className="mt-4 max-h-72 overflow-y-auto rounded-xl border border-[var(--line)]">
                    {summary.batch?.items.map((item) => {
                      const ordinal =
                        summary.batchOrdinals[item.ordinal - 1] ?? item.ordinal;
                      const duplicateItem = item.duplicateOfItemId
                        ? summary.batch?.items.find(
                            (candidate) => candidate.id === item.duplicateOfItemId,
                          )
                        : null;
                      const duplicateOrdinal = duplicateItem
                        ? (summary.batchOrdinals[duplicateItem.ordinal - 1] ??
                          duplicateItem.ordinal)
                        : null;
                      const failed =
                        item.state === "failed" ||
                        item.state === "cancelled" ||
                        item.jobState === "failed" ||
                        item.jobState === "cancelled";
                      const canRetry =
                        item.state === "failed" &&
                        item.jobState === "failed" &&
                        Boolean(item.jobId);
                      const status =
                        item.state === "invalid"
                          ? "Invalid"
                          : item.state === "duplicate"
                            ? "Duplicate"
                            : failed
                              ? "Failed"
                              : item.state === "succeeded" || item.jobState === "succeeded"
                                ? "Complete"
                                : item.state === "running" || item.jobState === "running"
                                  ? "Running"
                                  : "Queued";
                      return (
                        <div
                          key={item.id}
                          className="grid grid-cols-[2rem_minmax(0,1fr)_8rem] items-center gap-3 border-b border-[var(--line)] px-3 py-3 last:border-b-0"
                        >
                          <span className="font-mono text-[9px] text-[var(--muted)]">
                            {String(ordinal).padStart(2, "0")}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-[10px] font-semibold text-[var(--ink)]">
                              {item.originalUrl ?? "Invalid row"}
                            </span>
                            {item.normalizedUrl && (
                              <span className="mt-0.5 block truncate font-mono text-[9px] text-[var(--muted)]">
                                {item.normalizedUrl}
                              </span>
                            )}
                            {item.kind === "youtube_channel" && (
                              <span className="mt-0.5 block text-[9px] text-[var(--accent-strong)]">
                                Monitored · Daily · latest 25
                              </span>
                            )}
                            {(item.validationSummary || failed || duplicateOrdinal) && (
                              <span
                                className={cn(
                                  "mt-0.5 block text-[9px]",
                                  failed || item.validationSummary
                                    ? "text-[var(--danger)]"
                                    : "text-[var(--warning)]",
                                )}
                              >
                                {item.validationSummary ??
                                  (failed
                                    ? canRetry
                                      ? "Background job failed. Retry this row."
                                      : item.state === "duplicate"
                                        ? "Duplicate of an existing import whose job failed."
                                        : "Background job failed."
                                    : `Duplicate of row ${duplicateOrdinal}`)}
                              </span>
                            )}
                          </span>
                          <span className="flex justify-end">
                            {canRetry ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => retryItem(item)}
                                disabled={busyItemId === item.id}
                                aria-label={`Retry row ${ordinal}`}
                              >
                                {busyItemId === item.id ? (
                                  <LoaderCircle className="size-3 animate-spin" />
                                ) : (
                                  <RotateCcw className="size-3" />
                                )}
                                Retry
                              </Button>
                            ) : (
                              <Badge
                                variant={
                                  status === "Complete"
                                    ? "success"
                                    : status === "Failed" || status === "Invalid"
                                      ? "danger"
                                      : status === "Duplicate"
                                        ? "warning"
                                        : "accent"
                                }
                              >
                                {status}
                              </Badge>
                            )}
                          </span>
                        </div>
                      );
                    })}
                    {summary.items.map((item) => (
                      <div
                        key={`${item.ordinal}:${item.input}`}
                        className="grid grid-cols-[2rem_minmax(0,1fr)_8rem] items-center gap-3 border-b border-[var(--line)] px-3 py-3 last:border-b-0"
                      >
                        <span className="font-mono text-[9px] text-[var(--muted)]">
                          {String(item.ordinal).padStart(2, "0")}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[10px] font-semibold text-[var(--ink)]">
                            {item.input}
                          </span>
                          <span
                            className={cn(
                              "mt-0.5 block text-[9px]",
                              item.state === "failed"
                                ? "text-[var(--danger)]"
                                : "text-[var(--muted)]",
                            )}
                          >
                            {item.error ?? item.label}
                          </span>
                        </span>
                        <Badge
                          variant={
                            item.state === "failed"
                              ? "danger"
                              : item.state === "duplicate"
                                ? "warning"
                                : "accent"
                          }
                          className="justify-self-end"
                        >
                          {item.state === "failed"
                            ? "Failed"
                            : item.state === "duplicate"
                              ? "Duplicate"
                              : "Queued"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
                {error && (
                  <p className="mt-3 text-xs font-medium text-[var(--danger)]" role="alert">
                    {error}
                  </p>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  {summary.batch && (
                    <Button variant="ghost" onClick={refreshBatch} disabled={busy}>
                      <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
                      Refresh status
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => setSummary(null)}>
                    Import more
                  </Button>
                  <Button variant="accent" onClick={onViewActivity}>
                    View activity
                  </Button>
                </div>
              </div>
            ) : mode === "single" ? (
              <form onSubmit={submitSingle} className="p-6">
                <label htmlFor="import-url" className="text-xs font-semibold text-[var(--ink)]">
                  Source URL
                </label>
                <Input
                  id="import-url"
                  className="mt-2"
                  placeholder="https://youtube.com/watch?v=…"
                  value={singleValue}
                  onChange={(event) => setSingleValue(event.target.value)}
                  autoFocus
                  inputMode="url"
                  required
                />
                <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">
                  YouTube video or channel, GitHub repository, or project website.
                </p>
                {error && (
                  <p className="mt-3 text-xs font-medium text-[var(--danger)]" role="alert">
                    {error}
                  </p>
                )}
                <div className="mt-6 flex justify-end gap-2">
                  <Dialog.Close className={buttonVariants({ variant: "secondary" })}>
                    Cancel
                  </Dialog.Close>
                  <Button variant="accent" type="submit" disabled={busy}>
                    <Plus className="size-4" /> {busy ? "Queuing…" : "Queue import"}
                  </Button>
                </div>
              </form>
            ) : (
              <form onSubmit={submitBulk} className="p-6">
                <label htmlFor="bulk-import" className="text-xs font-semibold text-[var(--ink)]">
                  One URL per line
                </label>
                <textarea
                  id="bulk-import"
                  className="mt-2 min-h-36 w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 font-mono text-xs leading-5 text-[var(--ink)] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
                  placeholder={"# Paste a research list\nhttps://youtu.be/…\nhttps://github.com/owner/repo"}
                  value={bulkValue}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setBulkValue(nextValue);
                    setRows([]);
                    setPreviewError(null);
                    setError(null);
                    setPreviewing(physicalLines(nextValue).length > 0);
                  }}
                  autoFocus
                />
                <div className="mt-3 max-h-52 overflow-y-auto rounded-xl border border-[var(--line)]">
                  {previewing ? (
                    <p className="flex items-center gap-2 p-4 text-xs text-[var(--muted)]" role="status">
                      <LoaderCircle className="size-3.5 animate-spin" /> Checking rows with the server…
                    </p>
                  ) : rows.length === 0 ? (
                    <p className="p-4 text-xs text-[var(--muted)]">
                      Preview appears here. Blank lines and lines beginning with # are ignored.
                    </p>
                  ) : (
                    <div className="divide-y divide-[var(--line)]">
                      {rows.map((row) => (
                        <div
                          key={`${row.ordinal}:${row.input}`}
                          className="grid grid-cols-[2rem_minmax(0,1fr)_10rem] items-center gap-3 px-3 py-2.5"
                        >
                          <span className="font-mono text-[9px] text-[var(--muted)]">
                            {String(row.ordinal).padStart(2, "0")}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-[10px] font-semibold">
                              {row.input}
                            </span>
                            {row.normalizedUrl && (
                              <span className="mt-0.5 block truncate font-mono text-[9px] text-[var(--muted)]">
                                {row.normalizedUrl}
                              </span>
                            )}
                            {row.kind === "youtube_channel" && row.state === "ready" && (
                              <span className="mt-0.5 block text-[9px] text-[var(--accent-strong)]">
                                Monitored · Daily · latest 25
                              </span>
                            )}
                            {row.error && (
                              <span className="mt-0.5 block text-[9px] text-[var(--danger)]">
                                {row.error}
                              </span>
                            )}
                            {row.duplicateOf && (
                              <span className="mt-0.5 block text-[9px] text-[var(--warning)]">
                                Duplicate of row {row.duplicateOf}
                              </span>
                            )}
                          </span>
                          <Badge
                            variant={
                              row.state === "invalid"
                                ? "danger"
                                : row.state === "duplicate"
                                  ? "warning"
                                  : "accent"
                            }
                            className="justify-self-end"
                          >
                            {kindLabel(row.kind)}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {(previewError || error) && (
                  <p className="mt-3 text-xs font-medium text-[var(--danger)]" role="alert">
                    {previewError ?? error}
                  </p>
                )}
                <div className="mt-5 flex items-center justify-between">
                  <p className="text-[10px] text-[var(--muted)]">
                    {previewing
                      ? "Checking preview…"
                      : `${validRows.length} ready · ${rows.length - validRows.length} skipped`}
                  </p>
                  <div className="flex gap-2">
                    <Dialog.Close className={buttonVariants({ variant: "secondary" })}>
                      Cancel
                    </Dialog.Close>
                    <Button
                      variant="accent"
                      type="submit"
                      disabled={
                        busy ||
                        previewing ||
                        Boolean(previewError) ||
                        !validRows.length ||
                        rows.length > 500
                      }
                    >
                      <Plus className="size-4" /> {busy ? "Queuing…" : `Queue ${validRows.length}`}
                    </Button>
                  </div>
                </div>
              </form>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ThemeButton() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const next =
    preference === "system" ? "light" : preference === "light" ? "dark" : "system";
  const Icon = preference === "system" ? Monitor : resolvedTheme === "dark" ? Moon : Sun;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setPreference(next)}
      aria-label={`Theme: ${preference}. Switch to ${next}.`}
      title={`Theme: ${preference}`}
    >
      <Icon className="size-4" />
    </Button>
  );
}

export function HardwareShell({
  children,
  mode,
}: {
  children: ReactNode;
  mode: RuntimeMode;
}) {
  const router = useRouter();
  const [importOpen, setImportOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useState("");

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = quickSearch.trim();
    router.push(query ? `/inventory?q=${encodeURIComponent(query)}` : "/inventory");
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (window.innerWidth < 1024) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        document.getElementById("global-search")?.focus();
      }
      if (key === "i") {
        event.preventDefault();
        setImportOpen(true);
      }
    }
    function onResize() {
      if (window.innerWidth < 1024) setImportOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <>
      <div className="grid min-h-screen place-items-center bg-[var(--canvas)] px-8 text-center text-[var(--ink)] min-[1024px]:hidden">
        <div className="max-w-md rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-8 shadow-sm">
          <span className="mx-auto grid size-11 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
            <Monitor className="size-5" />
          </span>
          <h1 className="mt-5 text-xl font-bold tracking-[-0.03em]">
            Hardware needs a desktop window
          </h1>
          <p className="mt-2 text-sm leading-6 text-[var(--muted-strong)]">
            Widen this browser to at least 1024 pixels to open the research workspace.
          </p>
        </div>
      </div>

      <div className="hidden min-h-screen bg-[var(--canvas)] text-[var(--ink)] min-[1024px]:block">
        <aside className="fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-[var(--sidebar)]">
          <SidebarContent mode={mode} />
        </aside>

        <div className="pl-64">
          <header className="sticky top-0 z-30 flex h-18 items-center gap-3 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--canvas)_88%,transparent)] px-8 backdrop-blur-xl">
            <form onSubmit={search} className="relative max-w-2xl flex-1" role="search">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" />
              <Input
                id="global-search"
                value={quickSearch}
                onChange={(event) => setQuickSearch(event.target.value)}
                placeholder="Search projects, repositories, topics, videos…"
                aria-label="Search Hardware"
                className="h-9 bg-[var(--surface)] pl-9 pr-16"
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded border border-[var(--line)] bg-[var(--surface-raised)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--muted)]">
                <Command className="size-2.5" /> K
              </span>
            </form>

            <ThemeButton />
            <Link
              href="/docs"
              className={buttonVariants({ variant: "ghost", size: "icon" })}
              aria-label="How Hardware works"
              title="How Hardware works"
            >
              <BookOpen className="size-4" />
            </Link>
            <Button variant="accent" size="sm" onClick={() => setImportOpen(true)}>
              <Plus className="size-3.5" />
              Import
              <span className="ml-1 rounded border border-white/20 px-1 py-0.5 text-[9px] font-bold text-white/70">
                <Command className="mr-0.5 inline size-2.5" />I
              </span>
            </Button>
          </header>

          <main id="main-content" className="mx-auto w-full max-w-[1560px] px-8 py-8">
            {children}
          </main>
        </div>

        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          onViewActivity={() => {
            setImportOpen(false);
            router.push("/activity");
          }}
        />
        <DesktopOnboarding />
      </div>
    </>
  );
}
