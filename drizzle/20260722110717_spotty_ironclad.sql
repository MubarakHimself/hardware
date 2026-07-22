CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE TYPE "public"."collection_visibility" AS ENUM('private', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."event_level" AS ENUM('debug', 'info', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."ingestion_job_state" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ingestion_job_type" AS ENUM('channel_backfill', 'channel_poll', 'video_ingest', 'youtube_revalidate', 'website_metadata', 'repository_resolve', 'repository_refresh');--> statement-breakpoint
CREATE TYPE "public"."link_kind" AS ENUM('website', 'repository', 'documentation', 'demo', 'other');--> statement-breakpoint
CREATE TYPE "public"."link_verification_state" AS ENUM('unverified', 'verified', 'unreachable', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."project_review_state" AS ENUM('unreviewed', 'reviewed', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."project_state" AS ENUM('active', 'archived', 'merged');--> statement-breakpoint
CREATE TYPE "public"."repository_candidate_state" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."repository_provider" AS ENUM('github');--> statement-breakpoint
CREATE TYPE "public"."source_state" AS ENUM('active', 'paused', 'error');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('member', 'admin');--> statement-breakpoint
CREATE TYPE "public"."video_availability" AS ENUM('available', 'unavailable', 'deleted');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" uuid,
	"action" varchar(120) NOT NULL,
	"target_type" varchar(80) NOT NULL,
	"target_id" varchar(300) NOT NULL,
	"correlation_id" uuid NOT NULL,
	"before_summary" jsonb,
	"after_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"youtube_channel_id" varchar(64) NOT NULL,
	"uploads_playlist_id" varchar(64) NOT NULL,
	"handle" varchar(128),
	"title" varchar(300) NOT NULL,
	"canonical_url" text NOT NULL,
	"thumbnail_url" text,
	"state" "source_state" DEFAULT 'active' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"last_error_summary" varchar(500),
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_projects" (
	"collection_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"added_by_user_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_projects_collection_id_project_id_pk" PRIMARY KEY("collection_id","project_id"),
	CONSTRAINT "collection_projects_position_nonnegative" CHECK ("collection_projects"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" varchar(1000),
	"visibility" "collection_visibility" DEFAULT 'private' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_version_positive" CHECK ("collections"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "ingestion_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ingestion_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" uuid NOT NULL,
	"level" "event_level" DEFAULT 'info' NOT NULL,
	"code" varchar(80) NOT NULL,
	"message" varchar(500) NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graphile_job_id" bigint,
	"type" "ingestion_job_type" NOT NULL,
	"state" "ingestion_job_state" DEFAULT 'queued' NOT NULL,
	"idempotency_key" varchar(300) NOT NULL,
	"scope_type" varchar(80) NOT NULL,
	"scope_id" varchar(300) NOT NULL,
	"requested_by_user_id" uuid,
	"correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"completed_items" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_error_code" varchar(80),
	"safe_error_summary" varchar(500),
	"run_after" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_jobs_attempts_valid" CHECK ("ingestion_jobs"."attempts" >= 0 and "ingestion_jobs"."max_attempts" > 0 and "ingestion_jobs"."attempts" <= "ingestion_jobs"."max_attempts"),
	CONSTRAINT "ingestion_jobs_progress_valid" CHECK ("ingestion_jobs"."total_items" >= 0 and "ingestion_jobs"."completed_items" >= 0 and "ingestion_jobs"."completed_items" <= "ingestion_jobs"."total_items" and "ingestion_jobs"."warning_count" >= 0 and "ingestion_jobs"."failure_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"alias" varchar(300) NOT NULL,
	"normalized_alias" varchar(300) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "link_kind" DEFAULT 'other' NOT NULL,
	"label" varchar(200),
	"original_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"verification_state" "link_verification_state" DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_notes" (
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"body" varchar(10000) DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_notes_owner_user_id_project_id_pk" PRIMARY KEY("owner_user_id","project_id"),
	CONSTRAINT "project_notes_version_positive" CHECK ("project_notes"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "project_preferences" (
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"is_impressive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_preferences_owner_user_id_project_id_pk" PRIMARY KEY("owner_user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(160) NOT NULL,
	"name" varchar(300) NOT NULL,
	"description" text,
	"normalized_primary_url" text,
	"primary_url" text,
	"logo_url" text,
	"state" "project_state" DEFAULT 'active' NOT NULL,
	"review_state" "project_review_state" DEFAULT 'unreviewed' NOT NULL,
	"primary_repository_id" uuid,
	"merged_into_project_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_version_positive" CHECK ("projects"."version" > 0),
	CONSTRAINT "projects_merge_target_required" CHECK (("projects"."state" = 'merged' and "projects"."merged_into_project_id" is not null) or ("projects"."state" <> 'merged' and "projects"."merged_into_project_id" is null))
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "repository_provider" DEFAULT 'github' NOT NULL,
	"provider_repository_id" varchar(80) NOT NULL,
	"owner" varchar(160) NOT NULL,
	"name" varchar(160) NOT NULL,
	"canonical_url" text NOT NULL,
	"homepage_url" text,
	"description" text,
	"default_branch" varchar(255),
	"head_sha" varchar(64),
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_language" varchar(100),
	"languages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"license_spdx" varchar(80),
	"stars" integer DEFAULT 0 NOT NULL,
	"forks" integer DEFAULT 0 NOT NULL,
	"open_issues" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"fork" boolean DEFAULT false NOT NULL,
	"pushed_at" timestamp with time zone,
	"latest_release_at" timestamp with time zone,
	"metadata_refreshed_at" timestamp with time zone,
	"refresh_error_summary" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_counts_nonnegative" CHECK ("repositories"."stars" >= 0 and "repositories"."forks" >= 0 and "repositories"."open_issues" >= 0)
);
--> statement-breakpoint
CREATE TABLE "repository_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "repository_provider" DEFAULT 'github' NOT NULL,
	"provider_repository_id" varchar(80),
	"owner" varchar(160) NOT NULL,
	"name" varchar(160) NOT NULL,
	"canonical_url" text NOT NULL,
	"discovery_method" varchar(80) NOT NULL,
	"evidence_hash" varchar(128) NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score_basis_points" integer NOT NULL,
	"state" "repository_candidate_state" DEFAULT 'pending' NOT NULL,
	"decision_reason" varchar(500),
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_candidates_score_range" CHECK ("repository_candidates"."score_basis_points" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"timestamp_seconds" integer NOT NULL,
	"timestamp_label" varchar(16) NOT NULL,
	"raw_segment" text,
	"original_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"parser_version" varchar(32) NOT NULL,
	"source_position" integer DEFAULT 0 NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sightings_timestamp_nonnegative" CHECK ("sightings"."timestamp_seconds" >= 0),
	CONSTRAINT "sightings_position_nonnegative" CHECK ("sightings"."source_position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" varchar(128) NOT NULL,
	"email" varchar(320),
	"display_name" varchar(160),
	"avatar_url" text,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "video_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"youtube_video_id" varchar(32) NOT NULL,
	"title" varchar(500),
	"description" text,
	"etag" varchar(160),
	"published_at" timestamp with time zone,
	"duration_seconds" integer,
	"availability" "video_availability" DEFAULT 'available' NOT NULL,
	"description_fetched_at" timestamp with time zone,
	"youtube_data_expires_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_sources_duration_nonnegative" CHECK ("video_sources"."duration_seconds" is null or "video_sources"."duration_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" varchar(200) PRIMARY KEY NOT NULL,
	"version" varchar(80) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sources" ADD CONSTRAINT "channel_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_projects" ADD CONSTRAINT "collection_projects_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_projects" ADD CONSTRAINT "collection_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_projects" ADD CONSTRAINT "collection_projects_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_events" ADD CONSTRAINT "ingestion_events_job_id_ingestion_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ingestion_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_aliases" ADD CONSTRAINT "project_aliases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_links" ADD CONSTRAINT "project_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_notes" ADD CONSTRAINT "project_notes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_notes" ADD CONSTRAINT "project_notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_preferences" ADD CONSTRAINT "project_preferences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_preferences" ADD CONSTRAINT "project_preferences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_primary_repository_id_repositories_id_fk" FOREIGN KEY ("primary_repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_merged_into_project_id_projects_id_fk" FOREIGN KEY ("merged_into_project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_candidates" ADD CONSTRAINT "repository_candidates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_candidates" ADD CONSTRAINT "repository_candidates_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_channel_id_channel_sources_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sightings" ADD CONSTRAINT "sightings_video_id_video_sources_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_sources" ADD CONSTRAINT "video_sources_channel_id_channel_sources_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_created_idx" ON "audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_sources_youtube_channel_uidx" ON "channel_sources" USING btree ("youtube_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_sources_uploads_playlist_uidx" ON "channel_sources" USING btree ("uploads_playlist_id");--> statement-breakpoint
CREATE INDEX "channel_sources_schedule_idx" ON "channel_sources" USING btree ("enabled","next_sync_at");--> statement-breakpoint
CREATE INDEX "collection_projects_project_idx" ON "collection_projects" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_owner_name_uidx" ON "collections" USING btree ("owner_user_id","name");--> statement-breakpoint
CREATE INDEX "collections_visibility_idx" ON "collections" USING btree ("visibility","updated_at");--> statement-breakpoint
CREATE INDEX "ingestion_events_job_created_idx" ON "ingestion_events" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_jobs_idempotency_uidx" ON "ingestion_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_queue_idx" ON "ingestion_jobs" USING btree ("state","run_after");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_scope_idx" ON "ingestion_jobs" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_aliases_normalized_uidx" ON "project_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "project_aliases_project_idx" ON "project_aliases" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_links_project_normalized_uidx" ON "project_links" USING btree ("project_id","normalized_url");--> statement-breakpoint
CREATE INDEX "project_links_normalized_idx" ON "project_links" USING btree ("normalized_url");--> statement-breakpoint
CREATE INDEX "project_notes_project_idx" ON "project_notes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_preferences_impressive_idx" ON "project_preferences" USING btree ("owner_user_id","is_impressive");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_uidx" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_normalized_primary_url_uidx" ON "projects" USING btree ("normalized_primary_url");--> statement-breakpoint
CREATE INDEX "projects_state_created_idx" ON "projects" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_id_uidx" ON "repositories" USING btree ("provider","provider_repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_owner_name_uidx" ON "repositories" USING btree ("provider","owner","name");--> statement-breakpoint
CREATE INDEX "repositories_project_idx" ON "repositories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "repositories_refresh_idx" ON "repositories" USING btree ("metadata_refreshed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_candidates_evidence_uidx" ON "repository_candidates" USING btree ("project_id","provider","owner","name","evidence_hash");--> statement-breakpoint
CREATE INDEX "repository_candidates_review_queue_idx" ON "repository_candidates" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sightings_video_timestamp_url_uidx" ON "sightings" USING btree ("video_id","timestamp_seconds","normalized_url");--> statement-breakpoint
CREATE INDEX "sightings_project_ingested_idx" ON "sightings" USING btree ("project_id","ingested_at");--> statement-breakpoint
CREATE INDEX "sightings_channel_ingested_idx" ON "sightings" USING btree ("channel_id","ingested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_clerk_user_id_uidx" ON "users" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "video_sources_youtube_video_uidx" ON "video_sources" USING btree ("youtube_video_id");--> statement-breakpoint
CREATE INDEX "video_sources_channel_published_idx" ON "video_sources" USING btree ("channel_id","published_at");--> statement-breakpoint
CREATE INDEX "video_sources_revalidation_idx" ON "video_sources" USING btree ("availability","youtube_data_expires_at");--> statement-breakpoint

-- Identifier-heavy project names and URLs benefit from both lexical and trigram indexes.
CREATE INDEX "projects_search_fts_idx" ON "projects" USING gin (
  to_tsvector(
    'simple',
    coalesce("name", '') || ' ' ||
    coalesce("description", '') || ' ' ||
    coalesce("primary_url", '') || ' ' ||
    coalesce("normalized_primary_url", '')
  )
);--> statement-breakpoint
CREATE INDEX "projects_name_trgm_idx" ON "projects" USING gin ((lower("name")) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "projects_url_trgm_idx" ON "projects" USING gin ((lower(coalesce("normalized_primary_url", ''))) gin_trgm_ops);--> statement-breakpoint

CREATE INDEX "project_aliases_alias_trgm_idx" ON "project_aliases" USING gin ((lower("normalized_alias")) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_links_url_trgm_idx" ON "project_links" USING gin ((lower("normalized_url")) gin_trgm_ops);--> statement-breakpoint

CREATE INDEX "repositories_search_fts_idx" ON "repositories" USING gin (
  to_tsvector(
    'simple',
    coalesce("owner", '') || ' ' ||
    coalesce("name", '') || ' ' ||
    coalesce("description", '') || ' ' ||
    coalesce("primary_language", '') || ' ' ||
    coalesce("license_spdx", '') || ' ' ||
    coalesce("topics"::text, '')
  )
);--> statement-breakpoint
CREATE INDEX "repositories_identity_trgm_idx" ON "repositories" USING gin ((lower("owner" || '/' || "name")) gin_trgm_ops);--> statement-breakpoint

CREATE INDEX "channel_sources_title_trgm_idx" ON "channel_sources" USING gin ((lower("title")) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "video_sources_title_fts_idx" ON "video_sources" USING gin (to_tsvector('simple', coalesce("title", '')));--> statement-breakpoint
CREATE INDEX "collections_name_trgm_idx" ON "collections" USING gin ((lower("name")) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_notes_body_fts_idx" ON "project_notes" USING gin (to_tsvector('simple', "body"));--> statement-breakpoint

-- Audit history is append-only at the database boundary.
CREATE FUNCTION prevent_audit_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_prevent_update
BEFORE UPDATE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();--> statement-breakpoint
CREATE TRIGGER audit_events_prevent_delete
BEFORE DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();
