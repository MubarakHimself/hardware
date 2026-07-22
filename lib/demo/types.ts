export type RepositoryState = "verified" | "candidate" | "not-found";

export type ProjectActivity = "today" | "week" | "month" | "quiet";

export type DemoSighting = {
  id: string;
  channel: string;
  channelHandle: string;
  videoId: string;
  videoTitle: string;
  publishedAt: string;
  timestamp: string;
  timestampSeconds: number;
  rawSegment: string;
  originalUrl: string;
};

export type DemoProject = {
  id: string;
  name: string;
  description: string;
  domain: string;
  primaryUrl: string;
  logoUrl?: string | null;
  reviewState?: "unreviewed" | "reviewed" | "needs_review";
  additionalLinks?: Array<{
    id: string;
    kind: "website" | "repository" | "documentation" | "other";
    label: string | null;
    originalUrl: string;
    normalizedUrl: string;
    verificationState: "unverified" | "verified" | "rejected";
    verifiedAt: string | null;
  }>;
  repositoryUrl?: string;
  repositoryState: RepositoryState;
  repositoryLabel?: string;
  language?: string;
  license?: string;
  stars?: number;
  topics: string[];
  activity: ProjectActivity;
  activityLabel: string;
  seenAt: string;
  sightingCount: number;
  isNew?: boolean;
  isImpressive?: boolean;
  collectionIds: string[];
  accent: string;
  initials: string;
  note?: string;
  sightings: DemoSighting[];
};

export type DemoCollection = {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "workspace";
  projectIds: string[];
  updatedAt: string;
  accent: string;
};

export type DemoChannel = {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  status: "healthy" | "syncing" | "attention";
  videos: number;
  projects: number;
  progress?: number;
  progressLabel?: string;
  lastSync: string;
  nextSync: string;
};

export type DemoRepositoryCandidate = {
  id: string;
  projectId: string;
  projectName: string;
  repository: string;
  score: number;
  evidence: string[];
  discoveredAt: string;
};
