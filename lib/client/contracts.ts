export type RepositoryState = "verified" | "candidate" | "not-found";

export interface UiSighting {
  id: string;
  channel: string;
  channelHandle: string;
  channelId: string;
  videoId: string;
  videoTitle: string;
  publishedAt: string;
  timestamp: string;
  timestampSeconds: number;
  rawSegment: string;
  originalUrl: string;
  normalizedUrl: string;
}

export interface UiProject {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string;
  reviewState: "unreviewed" | "reviewed" | "needs_review";
  domain: string;
  primaryUrl: string;
  logoUrl?: string | null;
  repositoryUrl?: string;
  repositoryState: RepositoryState;
  repositoryLabel?: string;
  language?: string;
  license?: string;
  stars?: number;
  topics: string[];
  activityLabel: string;
  seenAt: string;
  sightingCount: number;
  isNew?: boolean;
  isImpressive: boolean;
  collectionIds: string[];
  accent: string;
  initials: string;
  note: string;
  noteVersion?: number;
  sightings: UiSighting[];
  links: Array<{
    id: string;
    kind: string;
    label?: string | null;
    originalUrl: string;
    normalizedUrl: string;
    verificationState?: string | null;
  }>;
  history: Array<{
    action: string;
    createdAt: string;
    correlationId?: string | null;
  }>;
  repository?: {
    owner: string;
    name: string;
    canonicalUrl: string;
    description?: string | null;
    defaultBranch?: string | null;
    headSha?: string | null;
    forks?: number;
    openIssues?: number;
  } | null;
}

export type UiJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface UiJob {
  id: string;
  type:
    | "channel_backfill"
    | "channel_poll"
    | "video_ingest"
    | "youtube_revalidate"
    | "website_metadata"
    | "repository_resolve"
    | "repository_refresh";
  state: UiJobState;
  scopeType: string;
  scopeId: string;
  attempts: number;
  maxAttempts: number;
  totalItems: number;
  completedItems: number;
  warningCount: number;
  failureCount: number;
  safeErrorCode: string | null;
  safeErrorSummary: string | null;
  requestedByMe: boolean;
  canRetry: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface UiCollection {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  visibility: "private" | "workspace";
  version: number;
  projectIds: string[];
  projectCount: number;
  updatedAt: string;
  canEdit: boolean;
  accent: string;
}

export interface UiRepositoryCandidate {
  id: string;
  projectId: string;
  projectName: string;
  repository: string;
  score: number;
  evidence: string[];
  discoveredAt: string;
  state: "pending" | "approved" | "rejected";
}

export interface UiChannel {
  id: string;
  name: string;
  handle: string;
  youtubeChannelId?: string;
  status: "healthy" | "syncing" | "attention";
  videos: number;
  projects: number;
  completed: number;
  warnings: number;
  failures: number;
  progress?: number;
  progressLabel?: string;
  lastSync: string;
  nextSync: string;
  retryableJobId?: string | null;
}

export interface ApiProblem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  correlationId?: string;
}

const accentPalette = [
  "#6546c7",
  "#245fc5",
  "#b43f2d",
  "#12685f",
  "#8a551f",
  "#405b9a",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function relativeDate(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value) return fallback;
  const instant = new Date(value).getTime();
  if (!Number.isFinite(instant)) return value;
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - instant) / 60_000));
  if (elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const hours = Math.round(elapsedMinutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function accentFor(identifier: string): string {
  let hash = 0;
  for (const character of identifier) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return accentPalette[Math.abs(hash) % accentPalette.length];
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "HW";
}

function domainFor(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return url || "Source unavailable";
  }
}

function normalizeSighting(value: unknown, index: number): UiSighting {
  const source = record(value);
  const channel = record(source.channel);
  const video = record(source.video);
  return {
    id: text(source.id, `sighting-${index}`),
    channel: text(source.channelTitle ?? source.channel_name ?? source.channel, text(channel.title, "Unknown channel")),
    channelHandle: text(source.channelHandle ?? source.channel_handle, text(channel.handle)),
    channelId: text(source.channelId ?? source.channel_id, text(channel.id)),
    videoId: text(source.youtubeVideoId ?? source.youtube_video_id ?? source.videoId, text(video.youtubeVideoId ?? video.id)),
    videoTitle: text(source.videoTitle ?? source.video_title, text(video.title, "Untitled video")),
    publishedAt: text(source.publishedAt ?? source.published_at, text(video.publishedAt)),
    timestamp: text(source.timestampLabel ?? source.timestamp_label ?? source.timestamp, "00:00"),
    timestampSeconds: number(source.timestampSeconds ?? source.timestamp_seconds),
    rawSegment: text(source.rawSegment ?? source.raw_segment),
    originalUrl: text(source.originalUrl ?? source.original_url),
    normalizedUrl: text(source.normalizedUrl ?? source.normalized_url, text(source.originalUrl ?? source.original_url)),
  };
}

export function normalizeProject(value: unknown): UiProject {
  const source = record(value);
  const note = record(source.note);
  const repository = record(source.repository);
  const legacyRepository = {
    owner: source.repositoryOwner ?? source.repository_owner,
    name: source.repositoryName ?? source.repository_name,
    canonicalUrl: source.repositoryUrl ?? source.repository_url,
    description: source.repositoryDescription ?? source.repository_description,
    defaultBranch: source.defaultBranch ?? source.default_branch,
    headSha: source.headSha ?? source.head_sha,
    forks: source.forks,
    openIssues: source.openIssues ?? source.open_issues,
  };
  const repositorySource = Object.keys(repository).length > 0 ? repository : record(legacyRepository);
  const primaryUrl = text(source.primaryUrl ?? source.primary_url);
  const name = text(source.name, "Untitled project");
  const latest = record(source.latestSighting);
  const suppliedSightings = Array.isArray(source.sightings) ? source.sightings : [];
  const sightings = suppliedSightings.length > 0
    ? suppliedSightings.map(normalizeSighting)
    : Object.keys(latest).length > 0
      ? [normalizeSighting(latest, 0)]
      : [];
  const repositoryStateValue = text(source.repositoryState ?? source.repository_state);
  const repositoryState: RepositoryState = repositoryStateValue === "attached" || repositoryStateValue === "verified"
    ? "verified"
    : repositoryStateValue === "pending" || repositoryStateValue === "candidate"
      ? "candidate"
      : "not-found";
  const repositoryUrl = text(repositorySource.canonicalUrl ?? repositorySource.canonical_url ?? source.repositoryUrl ?? source.repository_url);
  const repositoryOwner = text(repositorySource.owner);
  const repositoryName = text(repositorySource.name);
  const pushedAt = repository.pushedAt ?? repository.pushed_at ?? source.pushedAt ?? source.pushed_at;
  const seenAt = latest.seenAt ?? latest.seen_at ?? sightings[0]?.publishedAt ?? source.seenAt;
  const links = Array.isArray(source.links)
    ? source.links.map((item) => {
        const link = record(item);
        return {
          id: text(link.id, `link-${text(link.normalizedUrl ?? link.normalized_url ?? link.originalUrl ?? link.original_url)}`),
          kind: text(link.kind, "other"),
          label: typeof link.label === "string" ? link.label : null,
          originalUrl: text(link.originalUrl ?? link.original_url),
          normalizedUrl: text(link.normalizedUrl ?? link.normalized_url, text(link.originalUrl ?? link.original_url)),
          verificationState: typeof (link.verificationState ?? link.verification_state) === "string"
            ? text(link.verificationState ?? link.verification_state)
            : null,
        };
      })
    : [];
  const history = Array.isArray(source.history)
    ? source.history.map((item) => {
        const event = record(item);
        return {
          action: text(event.action, "project.updated"),
          createdAt: text(event.createdAt ?? event.created_at),
          correlationId: typeof (event.correlationId ?? event.correlation_id) === "string"
            ? text(event.correlationId ?? event.correlation_id)
            : null,
        };
      })
    : [];
  return {
    id: text(source.id ?? source.slug),
    slug: text(source.slug ?? source.id),
    version: Math.max(1, number(source.version, 1)),
    name,
    description: text(source.description, "No deterministic description is available yet."),
    reviewState: text(source.reviewState ?? source.review_state) === "reviewed"
      ? "reviewed"
      : text(source.reviewState ?? source.review_state) === "needs_review"
        ? "needs_review"
        : "unreviewed",
    domain: domainFor(primaryUrl),
    primaryUrl,
    logoUrl: typeof (source.logoUrl ?? source.logo_url) === "string"
      ? text(source.logoUrl ?? source.logo_url)
      : null,
    repositoryUrl: repositoryUrl || undefined,
    repositoryState,
    repositoryLabel: repositoryOwner && repositoryName ? `${repositoryOwner}/${repositoryName}` : text(source.repositoryLabel) || undefined,
    language: text(repository.primaryLanguage ?? repository.primary_language ?? source.primaryLanguage ?? source.primary_language) || undefined,
    license: text(repository.license ?? repository.licenseSpdx ?? repository.license_spdx ?? source.license ?? source.licenseSpdx ?? source.license_spdx) || undefined,
    stars: repository.stars !== undefined || source.stars !== undefined ? number(repository.stars ?? source.stars) : undefined,
    topics: textArray(repository.topics ?? source.topics),
    activityLabel: relativeDate(pushedAt, relativeDate(seenAt, "metadata pending")),
    seenAt: relativeDate(seenAt, "Not seen yet"),
    sightingCount: number(source.sightingCount ?? source.sighting_count, sightings.length),
    isNew: text(source.reviewState ?? source.review_state) === "unreviewed" || boolean(source.isNew),
    isImpressive: boolean(source.isImpressive ?? source.is_impressive),
    collectionIds: textArray(source.collectionIds ?? source.collection_ids),
    accent: accentFor(text(source.id ?? source.slug ?? name)),
    initials: initialsFor(name),
    note: text(note.body, text(source.note ?? source.privateNote ?? source.private_note)),
    noteVersion: note.version !== undefined || source.noteVersion !== undefined || source.note_version !== undefined
      ? number(note.version ?? source.noteVersion ?? source.note_version)
      : undefined,
    sightings,
    links,
    history,
    repository: repositoryUrl
      ? {
          owner: repositoryOwner,
          name: repositoryName,
          canonicalUrl: repositoryUrl,
          description: text(repositorySource.description) || null,
          defaultBranch: text(repositorySource.defaultBranch ?? repositorySource.default_branch) || null,
          headSha: text(repositorySource.headSha ?? repositorySource.head_sha) || null,
          forks: number(repositorySource.forks),
          openIssues: number(repositorySource.openIssues ?? repositorySource.open_issues),
        }
      : null,
  };
}

export function normalizeCollection(value: unknown): UiCollection {
  const source = record(value);
  const id = text(source.id);
  const projectIds = textArray(source.projectIds ?? source.project_ids);
  return {
    id,
    ownerId: text(source.ownerId ?? source.owner_id),
    name: text(source.name, "Untitled collection"),
    description: text(source.description),
    visibility: text(source.visibility) === "workspace" ? "workspace" : "private",
    version: Math.max(1, number(source.version, 1)),
    projectIds,
    projectCount: number(source.projectCount ?? source.project_count, projectIds.length),
    updatedAt: relativeDate(source.updatedAt ?? source.updated_at, "Recently"),
    canEdit: boolean(source.canEdit ?? source.can_edit),
    accent: accentFor(id),
  };
}

export function normalizeCandidate(value: unknown): UiRepositoryCandidate {
  const source = record(value);
  const repository = text(source.repository) || [text(source.owner), text(source.name)].filter(Boolean).join("/");
  const rawEvidence = source.evidence;
  const evidence = Array.isArray(rawEvidence)
    ? textArray(rawEvidence)
    : rawEvidence && typeof rawEvidence === "object"
      ? Object.entries(rawEvidence as Record<string, unknown>).map(([key, item]) => `${key}: ${text(item, String(item))}`)
      : [];
  const state = text(source.state);
  const scoreBasisPoints = number(source.scoreBasisPoints ?? source.score_basis_points, Number.NaN);
  const score = Number.isFinite(scoreBasisPoints)
    ? scoreBasisPoints / 100
    : number(source.score) * (number(source.score) <= 1 ? 100 : 1);
  return {
    id: text(source.id),
    projectId: text(source.projectId ?? source.project_id),
    projectName: text(source.projectName ?? source.project_name, "Project"),
    repository,
    score: Math.round(score),
    evidence,
    discoveredAt: relativeDate(source.discoveredAt ?? source.createdAt ?? source.created_at, "Recently"),
    state: state === "approved" || state === "rejected" ? state : "pending",
  };
}

export function normalizeChannel(value: unknown): UiChannel {
  const source = record(value);
  const state = text(source.status ?? source.latestJobState ?? source.latest_job_state ?? source.syncState ?? source.sync_state ?? source.state);
  const failures = number(source.failures ?? source.failureCount ?? source.failure_count);
  const warnings = number(source.warnings ?? source.warningCount ?? source.warning_count);
  const total = number(source.total ?? source.totalItems ?? source.total_items ?? source.videos ?? source.videoCount ?? source.video_count);
  const completed = number(source.completed ?? source.completedItems ?? source.completed_items ?? source.completedCount ?? source.completed_count, total);
  const progress = source.progress !== undefined
    ? number(source.progress)
    : total > 0 && completed < total
      ? Math.round((completed / total) * 100)
      : undefined;
  return {
    id: text(source.id),
    name: text(source.name ?? source.title, "Resolving channel…"),
    handle: text(source.handle ?? source.canonicalUrl ?? source.canonical_url),
    youtubeChannelId: text(source.youtubeChannelId ?? source.youtube_channel_id) || undefined,
    status: state === "running" || state === "queued" || state === "syncing"
      ? "syncing"
      : state === "failed" || state === "attention" || failures > 0 || warnings > 0
        ? "attention"
        : "healthy",
    videos: total,
    projects: number(source.projects ?? source.projectCount ?? source.project_count),
    completed,
    warnings,
    failures,
    progress,
    progressLabel: text(source.progressLabel ?? source.progress_label) || (total > 0 ? `${completed} of ${total} videos` : undefined),
    lastSync: relativeDate(source.lastSync ?? source.lastSyncedAt ?? source.last_synced_at ?? source.lastSuccessfulSyncAt ?? source.last_successful_sync_at, "Not synced yet"),
    nextSync: relativeDate(source.nextSync ?? source.nextSyncAt ?? source.next_sync_at ?? source.next_sync, "within 6 hours"),
    retryableJobId: text(source.retryableJobId ?? source.retryableFailedJobId ?? source.retryable_failed_job_id ?? source.retryable_job_id) || null,
  };
}

export function normalizeJob(value: unknown): UiJob {
  const source = record(value);
  const rawType = text(source.type);
  const type: UiJob["type"] = [
    "channel_backfill",
    "channel_poll",
    "video_ingest",
    "youtube_revalidate",
    "website_metadata",
    "repository_resolve",
    "repository_refresh",
  ].includes(rawType)
    ? (rawType as UiJob["type"])
    : "website_metadata";
  const rawState = text(source.state);
  const state: UiJobState = [
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ].includes(rawState)
    ? (rawState as UiJobState)
    : "queued";
  return {
    id: text(source.id),
    type,
    state,
    scopeType: text(source.scopeType ?? source.scope_type),
    scopeId: text(source.scopeId ?? source.scope_id),
    attempts: number(source.attempts),
    maxAttempts: Math.max(1, number(source.maxAttempts ?? source.max_attempts, 3)),
    totalItems: number(source.totalItems ?? source.total_items),
    completedItems: number(source.completedItems ?? source.completed_items),
    warningCount: number(source.warningCount ?? source.warning_count),
    failureCount: number(source.failureCount ?? source.failure_count),
    safeErrorCode: text(source.safeErrorCode ?? source.safe_error_code) || null,
    safeErrorSummary: text(source.safeErrorSummary ?? source.safe_error_summary) || null,
    requestedByMe: boolean(source.requestedByMe ?? source.requested_by_me),
    canRetry: boolean(source.canRetry ?? source.can_retry),
    createdAt: text(source.createdAt ?? source.created_at),
    updatedAt: text(source.updatedAt ?? source.updated_at, text(source.createdAt ?? source.created_at)),
    startedAt: text(source.startedAt ?? source.started_at) || null,
    finishedAt: text(source.finishedAt ?? source.finished_at) || null,
  };
}
