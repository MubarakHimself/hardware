import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["member", "admin"]);
export const sourceState = pgEnum("source_state", [
  "active",
  "paused",
  "error",
]);
export const videoAvailability = pgEnum("video_availability", [
  "available",
  "unavailable",
  "deleted",
]);
export const projectState = pgEnum("project_state", [
  "active",
  "archived",
  "merged",
]);
export const projectReviewState = pgEnum("project_review_state", [
  "unreviewed",
  "reviewed",
  "needs_review",
]);
export const linkKind = pgEnum("link_kind", [
  "website",
  "repository",
  "documentation",
  "demo",
  "other",
]);
export const linkVerificationState = pgEnum("link_verification_state", [
  "unverified",
  "verified",
  "unreachable",
  "rejected",
]);
export const repositoryProvider = pgEnum("repository_provider", ["github"]);
export const repositoryCandidateState = pgEnum(
  "repository_candidate_state",
  ["pending", "approved", "rejected"],
);
export const collectionVisibility = pgEnum("collection_visibility", [
  "private",
  "workspace",
]);
export const ingestionJobType = pgEnum("ingestion_job_type", [
  "channel_backfill",
  "channel_poll",
  "video_ingest",
  "youtube_revalidate",
  "website_metadata",
  "repository_resolve",
  "repository_refresh",
]);
export const ingestionJobState = pgEnum("ingestion_job_state", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const eventLevel = pgEnum("event_level", [
  "debug",
  "info",
  "warning",
  "error",
]);

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkUserId: varchar("clerk_user_id", { length: 128 }).notNull(),
    email: varchar("email", { length: 320 }),
    displayName: varchar("display_name", { length: 160 }),
    avatarUrl: text("avatar_url"),
    role: userRole("role").default("member").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("users_clerk_user_id_uidx").on(table.clerkUserId),
    index("users_role_idx").on(table.role),
  ],
);

export const channelSources = pgTable(
  "channel_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    youtubeChannelId: varchar("youtube_channel_id", { length: 64 }).notNull(),
    uploadsPlaylistId: varchar("uploads_playlist_id", { length: 64 }).notNull(),
    handle: varchar("handle", { length: 128 }),
    title: varchar("title", { length: 300 }).notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    state: sourceState("state").default("active").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    checkpoint: jsonb("checkpoint")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    lastErrorSummary: varchar("last_error_summary", { length: 500 }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("channel_sources_youtube_channel_uidx").on(
      table.youtubeChannelId,
    ),
    uniqueIndex("channel_sources_uploads_playlist_uidx").on(
      table.uploadsPlaylistId,
    ),
    index("channel_sources_schedule_idx").on(table.enabled, table.nextSyncAt),
  ],
);

export const videoSources = pgTable(
  "video_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channelSources.id, { onDelete: "restrict" }),
    youtubeVideoId: varchar("youtube_video_id", { length: 32 }).notNull(),
    title: varchar("title", { length: 500 }),
    description: text("description"),
    etag: varchar("etag", { length: 160 }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    availability: videoAvailability("availability")
      .default("available")
      .notNull(),
    descriptionFetchedAt: timestamp("description_fetched_at", {
      withTimezone: true,
    }),
    youtubeDataExpiresAt: timestamp("youtube_data_expires_at", {
      withTimezone: true,
    }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("video_sources_youtube_video_uidx").on(table.youtubeVideoId),
    index("video_sources_channel_published_idx").on(
      table.channelId,
      table.publishedAt,
    ),
    index("video_sources_revalidation_idx").on(
      table.availability,
      table.youtubeDataExpiresAt,
    ),
    check(
      "video_sources_duration_nonnegative",
      sql`${table.durationSeconds} is null or ${table.durationSeconds} >= 0`,
    ),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 160 }).notNull(),
    name: varchar("name", { length: 300 }).notNull(),
    description: text("description"),
    normalizedPrimaryUrl: text("normalized_primary_url"),
    primaryUrl: text("primary_url"),
    logoUrl: text("logo_url"),
    state: projectState("state").default("active").notNull(),
    reviewState: projectReviewState("review_state")
      .default("unreviewed")
      .notNull(),
    primaryRepositoryId: uuid("primary_repository_id").references(
      (): AnyPgColumn => repositories.id,
      { onDelete: "set null" },
    ),
    mergedIntoProjectId: uuid("merged_into_project_id").references(
      (): AnyPgColumn => projects.id,
      { onDelete: "restrict" },
    ),
    version: integer("version").default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("projects_slug_uidx").on(table.slug),
    uniqueIndex("projects_normalized_primary_url_uidx").on(
      table.normalizedPrimaryUrl,
    ),
    index("projects_state_created_idx").on(table.state, table.createdAt),
    check("projects_version_positive", sql`${table.version} > 0`),
    check(
      "projects_merge_target_required",
      sql`(${table.state} = 'merged' and ${table.mergedIntoProjectId} is not null) or (${table.state} <> 'merged' and ${table.mergedIntoProjectId} is null)`,
    ),
  ],
);

export const projectAliases = pgTable(
  "project_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    alias: varchar("alias", { length: 300 }).notNull(),
    normalizedAlias: varchar("normalized_alias", { length: 300 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("project_aliases_normalized_uidx").on(table.normalizedAlias),
    index("project_aliases_project_idx").on(table.projectId),
  ],
);

export const projectLinks = pgTable(
  "project_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: linkKind("kind").default("other").notNull(),
    label: varchar("label", { length: 200 }),
    originalUrl: text("original_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    verificationState: linkVerificationState("verification_state")
      .default("unverified")
      .notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("project_links_project_normalized_uidx").on(
      table.projectId,
      table.normalizedUrl,
    ),
    index("project_links_normalized_idx").on(table.normalizedUrl),
  ],
);

export const sightings = pgTable(
  "sightings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channelSources.id, { onDelete: "restrict" }),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videoSources.id, { onDelete: "restrict" }),
    timestampSeconds: integer("timestamp_seconds").notNull(),
    timestampLabel: varchar("timestamp_label", { length: 16 }).notNull(),
    rawSegment: text("raw_segment"),
    originalUrl: text("original_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    parserVersion: varchar("parser_version", { length: 32 }).notNull(),
    sourcePosition: integer("source_position").default(0).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("sightings_video_timestamp_url_uidx").on(
      table.videoId,
      table.timestampSeconds,
      table.normalizedUrl,
    ),
    index("sightings_project_ingested_idx").on(
      table.projectId,
      table.ingestedAt,
    ),
    index("sightings_channel_ingested_idx").on(
      table.channelId,
      table.ingestedAt,
    ),
    check(
      "sightings_timestamp_nonnegative",
      sql`${table.timestampSeconds} >= 0`,
    ),
    check("sightings_position_nonnegative", sql`${table.sourcePosition} >= 0`),
  ],
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: repositoryProvider("provider").default("github").notNull(),
    providerRepositoryId: varchar("provider_repository_id", {
      length: 80,
    }).notNull(),
    owner: varchar("owner", { length: 160 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    homepageUrl: text("homepage_url"),
    description: text("description"),
    defaultBranch: varchar("default_branch", { length: 255 }),
    headSha: varchar("head_sha", { length: 64 }),
    topics: jsonb("topics").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    primaryLanguage: varchar("primary_language", { length: 100 }),
    languages: jsonb("languages")
      .$type<Record<string, number>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    licenseSpdx: varchar("license_spdx", { length: 80 }),
    stars: integer("stars").default(0).notNull(),
    forks: integer("forks").default(0).notNull(),
    openIssues: integer("open_issues").default(0).notNull(),
    archived: boolean("archived").default(false).notNull(),
    fork: boolean("fork").default(false).notNull(),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    latestReleaseAt: timestamp("latest_release_at", { withTimezone: true }),
    metadataRefreshedAt: timestamp("metadata_refreshed_at", {
      withTimezone: true,
    }),
    refreshErrorSummary: varchar("refresh_error_summary", { length: 500 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("repositories_provider_id_uidx").on(
      table.provider,
      table.providerRepositoryId,
    ),
    uniqueIndex("repositories_provider_owner_name_uidx").on(
      table.provider,
      table.owner,
      table.name,
    ),
    index("repositories_project_idx").on(table.projectId),
    index("repositories_refresh_idx").on(table.metadataRefreshedAt),
    check(
      "repositories_counts_nonnegative",
      sql`${table.stars} >= 0 and ${table.forks} >= 0 and ${table.openIssues} >= 0`,
    ),
  ],
);

export const repositoryCandidates = pgTable(
  "repository_candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: repositoryProvider("provider").default("github").notNull(),
    providerRepositoryId: varchar("provider_repository_id", { length: 80 }),
    owner: varchar("owner", { length: 160 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    discoveryMethod: varchar("discovery_method", { length: 80 }).notNull(),
    evidenceHash: varchar("evidence_hash", { length: 128 }).notNull(),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    scoreBasisPoints: integer("score_basis_points").notNull(),
    state: repositoryCandidateState("state").default("pending").notNull(),
    decisionReason: varchar("decision_reason", { length: 500 }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("repository_candidates_evidence_uidx").on(
      table.projectId,
      table.provider,
      table.owner,
      table.name,
      table.evidenceHash,
    ),
    index("repository_candidates_review_queue_idx").on(
      table.state,
      table.createdAt,
    ),
    check(
      "repository_candidates_score_range",
      sql`${table.scoreBasisPoints} between 0 and 10000`,
    ),
  ],
);

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    description: varchar("description", { length: 1000 }),
    visibility: collectionVisibility("visibility").default("private").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("collections_owner_name_uidx").on(
      table.ownerUserId,
      table.name,
    ),
    index("collections_visibility_idx").on(table.visibility, table.updatedAt),
    check("collections_version_positive", sql`${table.version} > 0`),
  ],
);

export const collectionProjects = pgTable(
  "collection_projects",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    addedByUserId: uuid("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    position: integer("position").default(0).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.projectId] }),
    index("collection_projects_project_idx").on(table.projectId),
    check("collection_projects_position_nonnegative", sql`${table.position} >= 0`),
  ],
);

export const projectNotes = pgTable(
  "project_notes",
  {
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    body: varchar("body", { length: 10000 }).default("").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.projectId] }),
    index("project_notes_project_idx").on(table.projectId),
    check("project_notes_version_positive", sql`${table.version} > 0`),
  ],
);

export const projectPreferences = pgTable(
  "project_preferences",
  {
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    isImpressive: boolean("is_impressive").default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.projectId] }),
    index("project_preferences_impressive_idx").on(
      table.ownerUserId,
      table.isImpressive,
    ),
  ],
);

export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    graphileJobId: bigint("graphile_job_id", { mode: "number" }),
    type: ingestionJobType("type").notNull(),
    state: ingestionJobState("state").default("queued").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 300 }).notNull(),
    scopeType: varchar("scope_type", { length: 80 }).notNull(),
    scopeId: varchar("scope_id", { length: 300 }).notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    correlationId: uuid("correlation_id").defaultRandom().notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    totalItems: integer("total_items").default(0).notNull(),
    completedItems: integer("completed_items").default(0).notNull(),
    warningCount: integer("warning_count").default(0).notNull(),
    failureCount: integer("failure_count").default(0).notNull(),
    checkpoint: jsonb("checkpoint")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    safeErrorCode: varchar("safe_error_code", { length: 80 }),
    safeErrorSummary: varchar("safe_error_summary", { length: 500 }),
    runAfter: timestamp("run_after", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("ingestion_jobs_idempotency_uidx").on(table.idempotencyKey),
    index("ingestion_jobs_queue_idx").on(table.state, table.runAfter),
    index("ingestion_jobs_scope_idx").on(table.scopeType, table.scopeId),
    check(
      "ingestion_jobs_attempts_valid",
      sql`${table.attempts} >= 0 and ${table.maxAttempts} > 0 and ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check(
      "ingestion_jobs_progress_valid",
      sql`${table.totalItems} >= 0 and ${table.completedItems} >= 0 and ${table.completedItems} <= ${table.totalItems} and ${table.warningCount} >= 0 and ${table.failureCount} >= 0`,
    ),
  ],
);

export const ingestionEvents = pgTable(
  "ingestion_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => ingestionJobs.id, { onDelete: "cascade" }),
    level: eventLevel("level").default("info").notNull(),
    code: varchar("code", { length: 80 }).notNull(),
    message: varchar("message", { length: 500 }).notNull(),
    context: jsonb("context")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("ingestion_events_job_created_idx").on(table.jobId, table.createdAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    action: varchar("action", { length: 120 }).notNull(),
    targetType: varchar("target_type", { length: 80 }).notNull(),
    targetId: varchar("target_id", { length: 300 }).notNull(),
    correlationId: uuid("correlation_id").notNull(),
    beforeSummary: jsonb("before_summary").$type<Record<string, unknown>>(),
    afterSummary: jsonb("after_summary").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_events_target_idx").on(table.targetType, table.targetId),
    index("audit_events_actor_created_idx").on(table.actorUserId, table.createdAt),
    index("audit_events_correlation_idx").on(table.correlationId),
  ],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: varchar("worker_id", { length: 200 }).primaryKey(),
  version: varchar("version", { length: 80 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  details: jsonb("details")
    .$type<Record<string, unknown>>()
    .default(sql`'{}'::jsonb`)
    .notNull(),
});
