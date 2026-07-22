import "server-only";
import { randomUUID } from "node:crypto";
import {
  demoCandidates,
  demoChannels,
  demoCollections,
  demoProjects,
} from "../demo/catalog";
import type {
  IngestionJobType,
  JobState,
} from "../domain";
import type {
  DemoChannel,
  DemoCollection,
  DemoProject,
  DemoRepositoryCandidate,
} from "../demo/types";
import { DEMO_ACTOR_ID } from "./demo-identity";

export type DemoStoredCollection = DemoCollection & {
  ownerId: string;
  version: number;
};
export type DemoCandidateDecision = "approved" | "rejected";

export interface DemoQueuedImport {
  id: string;
  kind: "youtube_video" | "website" | "github_repository";
  url: string;
  state: "queued";
  correlationId: string;
  createdAt: string;
}

export interface DemoStoredJob {
  id: string;
  idempotencyKey: string;
  type: IngestionJobType;
  state: JobState;
  scopeType: string;
  scopeId: string;
  requestedByUserId: string | null;
  correlationId: string;
  attempts: number;
  maxAttempts: number;
  totalItems: number;
  completedItems: number;
  warningCount: number;
  failureCount: number;
  safeErrorCode: string | null;
  safeErrorSummary: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface DemoState {
  projects: DemoProject[];
  collections: DemoStoredCollection[];
  channels: DemoChannel[];
  candidates: DemoRepositoryCandidate[];
  candidateDecisions: Map<string, DemoCandidateDecision>;
  imports: Map<string, DemoQueuedImport>;
  jobs: Map<string, DemoStoredJob>;
  noteVersions: Map<string, number>;
  projectVersions: Map<string, number>;
  projectRedirects: Map<string, string>;
  audit: Array<Record<string, unknown>>;
}

const globalDemo = globalThis as typeof globalThis & {
  __hardwareDemoStore?: DemoState;
};

function initialState(): DemoState {
  return {
    projects: structuredClone(demoProjects),
    collections: structuredClone(demoCollections).map((collection) => ({
      ...collection,
      ownerId: DEMO_ACTOR_ID,
      version: 1,
    })),
    channels: structuredClone(demoChannels),
    candidates: structuredClone(demoCandidates),
    candidateDecisions: new Map(),
    imports: new Map(),
    jobs: new Map(),
    noteVersions: new Map(
      demoProjects.filter((project) => project.note).map((project) => [project.id, 1]),
    ),
    projectVersions: new Map(demoProjects.map((project) => [project.id, 1])),
    projectRedirects: new Map(),
    audit: [],
  };
}

export function getDemoState(): DemoState {
  globalDemo.__hardwareDemoStore ??= initialState();
  return globalDemo.__hardwareDemoStore;
}

export function resetDemoState(): void {
  globalDemo.__hardwareDemoStore = initialState();
}

export function createDemoCollection(input: {
  ownerId: string;
  name: string;
  description?: string;
  visibility: "private" | "workspace";
}): DemoStoredCollection {
  const state = getDemoState();
  const duplicate = state.collections.some(
    (collection) =>
      collection.ownerId === input.ownerId &&
      collection.name.toLocaleLowerCase() === input.name.toLocaleLowerCase(),
  );
  if (duplicate) {
    throw Object.assign(new Error("Collection names must be unique per owner."), {
      code: "23505",
    });
  }
  const collection: DemoStoredCollection = {
    id: randomUUID(),
    ownerId: input.ownerId,
    name: input.name,
    description: input.description ?? "",
    visibility: input.visibility,
    projectIds: [],
    updatedAt: new Date().toISOString(),
    accent: "#6546c7",
    version: 1,
  };
  state.collections.unshift(collection);
  return collection;
}
