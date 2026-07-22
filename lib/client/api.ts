import {
  normalizeCandidate,
  normalizeChannel,
  normalizeCollection,
  normalizeJob,
  normalizeProject,
  type ApiProblem,
  type UiChannel,
  type UiCollection,
  type UiJob,
  type UiProject,
  type UiRepositoryCandidate,
} from "./contracts";

interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export class HardwareApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId?: string;

  constructor(problem: ApiProblem, status: number) {
    super(problem.detail || problem.title || "The request could not be completed.");
    this.name = "HardwareApiError";
    this.status = status;
    this.code = problem.code ?? "request_failed";
    this.correlationId = problem.correlationId;
  }
}

function idempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T> & ApiProblem;
  if (!response.ok) throw new HardwareApiError(payload, response.status);
  return payload;
}

export function errorMessage(error: unknown): string {
  if (error instanceof HardwareApiError) {
    return error.correlationId ? `${error.message} Reference ${error.correlationId}.` : error.message;
  }
  return error instanceof Error ? error.message : "The request could not be completed.";
}

export async function listProjects(search: URLSearchParams): Promise<{
  projects: UiProject[];
  nextCursor: string | null;
  facets: Record<string, unknown>;
}> {
  const result = await request<unknown[]>(`/api/projects?${search.toString()}`);
  return {
    projects: Array.isArray(result.data) ? result.data.map(normalizeProject) : [],
    nextCursor: typeof result.meta?.nextCursor === "string" ? result.meta.nextCursor : null,
    facets: result.meta && typeof result.meta.facets === "object" && result.meta.facets
      ? (result.meta.facets as Record<string, unknown>)
      : {},
  };
}

export async function getProject(id: string): Promise<UiProject> {
  const result = await request<unknown>(`/api/projects/${encodeURIComponent(id)}`);
  return normalizeProject(result.data);
}

export interface ProjectEditResult {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  primaryUrl: string | null;
  logoUrl: string | null;
  reviewState: "unreviewed" | "reviewed" | "needs_review";
  version: number;
}

export async function updateProject(
  project: Pick<UiProject, "id" | "version">,
  input: {
    name?: string;
    description?: string | null;
    primaryUrl?: string | null;
    logoUrl?: string | null;
    reviewState?: "unreviewed" | "reviewed" | "needs_review";
  },
): Promise<ProjectEditResult> {
  const result = await request<ProjectEditResult>(
    `/api/projects/${encodeURIComponent(project.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ...input, version: project.version }),
    },
  );
  return result.data;
}

export interface ProjectMergeResult {
  sourceProjectId: string;
  targetProjectId: string;
  targetVersion: number;
}

export async function mergeProject(
  source: Pick<UiProject, "id" | "version">,
  target: Pick<UiProject, "id" | "version">,
): Promise<ProjectMergeResult> {
  const result = await request<ProjectMergeResult>(
    `/api/projects/${encodeURIComponent(source.id)}/merge`,
    {
      method: "POST",
      body: JSON.stringify({
        targetProjectId: target.id,
        sourceVersion: source.version,
        targetVersion: target.version,
      }),
    },
  );
  return result.data;
}

export interface ProjectSplitResult {
  sourceProjectId: string;
  projectId: string;
  sourceVersion: number;
}

export async function splitProject(
  source: Pick<UiProject, "id" | "version">,
  input: {
    name: string;
    description?: string;
    primaryUrl?: string | null;
    sightingIds: string[];
    linkIds?: string[];
  },
): Promise<ProjectSplitResult> {
  const result = await request<ProjectSplitResult>(
    `/api/projects/${encodeURIComponent(source.id)}/split`,
    {
      method: "POST",
      body: JSON.stringify({
        ...input,
        sourceVersion: source.version,
        linkIds: input.linkIds ?? [],
      }),
    },
  );
  return result.data;
}

export async function refreshProjectMetadata(
  projectId: string,
): Promise<{ projectId: string; jobs: UiJob[] }> {
  const result = await request<{ projectId: string; jobs: unknown[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/refresh`,
    { method: "POST" },
  );
  return {
    projectId: result.data.projectId,
    jobs: Array.isArray(result.data.jobs)
      ? result.data.jobs.map(normalizeJob)
      : [],
  };
}

export async function listCollections(): Promise<UiCollection[]> {
  const result = await request<unknown[]>("/api/collections");
  return Array.isArray(result.data) ? result.data.map(normalizeCollection) : [];
}

export async function createCollection(input: {
  name: string;
  description?: string;
  visibility?: "private" | "workspace";
}): Promise<UiCollection> {
  const result = await request<unknown>("/api/collections", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return normalizeCollection(result.data);
}

export async function updateCollection(
  collection: Pick<UiCollection, "id" | "version">,
  input: { name?: string; description?: string; visibility?: "private" | "workspace" },
): Promise<UiCollection> {
  const result = await request<unknown>(`/api/collections/${encodeURIComponent(collection.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...input, version: collection.version }),
  });
  return normalizeCollection(result.data);
}

export async function setCollectionMembership(
  collectionId: string,
  projectId: string,
  present: boolean,
): Promise<void> {
  await request(`/api/collections/${encodeURIComponent(collectionId)}/projects/${encodeURIComponent(projectId)}`, {
    method: present ? "PUT" : "DELETE",
  });
}

export async function saveProjectNote(projectId: string, body: string, version?: number): Promise<{ body: string; version: number }> {
  const result = await request<{ body: string; version: number }>(`/api/projects/${encodeURIComponent(projectId)}/note`, {
    method: "PUT",
    body: JSON.stringify({ body, ...(version ? { version } : {}) }),
  });
  return result.data;
}

export async function saveProjectPreference(projectId: string, isImpressive: boolean): Promise<void> {
  await request(`/api/projects/${encodeURIComponent(projectId)}/preference`, {
    method: "PUT",
    body: JSON.stringify({ isImpressive }),
  });
}

export async function queueImport(
  url: string,
  kind: "youtube_video" | "website" | "github_repository",
): Promise<UiJob> {
  const result = await request<unknown>("/api/imports", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey("ui-import") },
    body: JSON.stringify({ url, kind }),
  });
  return normalizeJob(result.data);
}

export async function listJobs(limit = 30): Promise<UiJob[]> {
  const result = await request<unknown[]>(`/api/jobs?limit=${limit}`);
  return Array.isArray(result.data) ? result.data.map(normalizeJob) : [];
}

export async function listRepositoryCandidates(): Promise<UiRepositoryCandidate[]> {
  const result = await request<unknown[]>("/api/repository-candidates");
  return Array.isArray(result.data) ? result.data.map(normalizeCandidate) : [];
}

export async function decideRepositoryCandidate(
  candidateId: string,
  decision: "approve" | "reject",
  reason?: string,
): Promise<void> {
  await request(`/api/repository-candidates/${encodeURIComponent(candidateId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
  });
}

export async function listChannels(): Promise<UiChannel[]> {
  const result = await request<unknown[]>("/api/channels");
  return Array.isArray(result.data) ? result.data.map(normalizeChannel) : [];
}

export async function addChannel(url: string): Promise<UiChannel> {
  const result = await request<unknown>("/api/channels", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  const payload = result.data && typeof result.data === "object" && "channel" in result.data
    ? (result.data as { channel: unknown }).channel
    : result.data;
  return normalizeChannel(payload);
}

export async function syncChannel(id: string): Promise<Record<string, unknown>> {
  const result = await request<Record<string, unknown>>(`/api/channels/${encodeURIComponent(id)}/sync`, {
    method: "POST",
  });
  return result.data;
}

export async function retryJob(id: string): Promise<{ id: string; state: string; created: boolean }> {
  const result = await request<{ id: string; state: string; created: boolean }>(`/api/jobs/${encodeURIComponent(id)}/retry`, {
    method: "POST",
  });
  return result.data;
}
