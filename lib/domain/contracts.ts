export const USER_ROLES = ["member", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const COLLECTION_VISIBILITIES = ["private", "workspace"] as const;
export type CollectionVisibility = (typeof COLLECTION_VISIBILITIES)[number];

export const PROJECT_STATES = ["active", "archived", "merged"] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const LINK_KINDS = [
  "website",
  "repository",
  "documentation",
  "demo",
  "other",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_VERIFICATION_STATES = [
  "unverified",
  "verified",
  "unreachable",
  "rejected",
] as const;
export type LinkVerificationState =
  (typeof LINK_VERIFICATION_STATES)[number];

export const IMPORT_KINDS = [
  "youtube_video",
  "website",
  "github_repository",
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const INGESTION_JOB_TYPES = [
  "channel_backfill",
  "channel_poll",
  "video_ingest",
  "youtube_revalidate",
  "website_metadata",
  "repository_resolve",
  "repository_refresh",
] as const;
export type IngestionJobType = (typeof INGESTION_JOB_TYPES)[number];

export const PROJECT_REVIEW_STATES = [
  "unreviewed",
  "reviewed",
  "needs_review",
] as const;
export type ProjectReviewState = (typeof PROJECT_REVIEW_STATES)[number];

export const REPOSITORY_CANDIDATE_STATES = [
  "pending",
  "approved",
  "rejected",
] as const;
export type RepositoryCandidateState =
  (typeof REPOSITORY_CANDIDATE_STATES)[number];

export const JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const SOURCE_AVAILABILITIES = [
  "available",
  "unavailable",
  "deleted",
] as const;
export type SourceAvailability = (typeof SOURCE_AVAILABILITIES)[number];

export const REPOSITORY_FILTERS = ["none", "pending", "attached"] as const;
export type RepositoryFilter = (typeof REPOSITORY_FILTERS)[number];

export const ACTIVITY_FILTERS = ["30d", "90d", "stale"] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export const PROJECT_SORTS = [
  "relevance",
  "newest",
  "recently_seen",
  "name",
  "repository_activity",
] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

export const PROJECT_VIEWS = ["cards", "list"] as const;
export type ProjectView = (typeof PROJECT_VIEWS)[number];

/** A signed-in Hardware user resolved from Clerk to the internal users row. */
export interface AuthenticatedActor {
  /** Internal users.id; ownership foreign keys must never store the Clerk subject. */
  userId: string;
  clerkUserId?: string;
  role: UserRole;
}

export interface OwnedResource {
  ownerId: string;
}

export interface CollectionAccessResource extends OwnedResource {
  visibility: CollectionVisibility;
}

export interface ImportCommand {
  kind: ImportKind;
  url: string;
}

export interface ProjectSearchQuery {
  q?: string;
  channel?: string;
  repository?: RepositoryFilter;
  language?: string;
  license?: string;
  activity?: ActivityFilter;
  collection?: string;
  impressive?: boolean;
  sort: ProjectSort;
  view: ProjectView;
  cursor?: string;
  limit: number;
}
