CREATE TYPE "public"."channel_sync_frequency" AS ENUM('manual', 'daily', 'weekly');
--> statement-breakpoint
CREATE TYPE "public"."channel_history_mode" AS ENUM('latest_10', 'latest_25', 'latest_50', 'since', 'all');
--> statement-breakpoint
CREATE TYPE "public"."import_batch_state" AS ENUM('processing', 'queued', 'partial', 'failed');
--> statement-breakpoint
CREATE TYPE "public"."import_batch_item_state" AS ENUM('queued', 'duplicate', 'invalid');
--> statement-breakpoint
CREATE TYPE "public"."source_review_state" AS ENUM('open', 'resolved', 'ignored');
--> statement-breakpoint
ALTER TABLE "channel_sources" ALTER COLUMN "enabled" SET DEFAULT false;
--> statement-breakpoint
-- Before personal-local v1.1, video ingestion created provenance channel rows
-- under an enabled-by-default schema. Disable only untouched provenance rows.
-- Any durable sign of monitoring intent or channel-sync activity wins, so this
-- correction cannot reset a genuinely monitored channel or any of its settings.
UPDATE "channel_sources" AS "legacy_channel"
   SET "enabled" = false
 WHERE "legacy_channel"."enabled" = true
   AND "legacy_channel"."created_by_user_id" IS NULL
   AND "legacy_channel"."state" = 'active'
   AND "legacy_channel"."checkpoint" = '{}'::jsonb
   AND "legacy_channel"."last_synced_at" IS NULL
   AND "legacy_channel"."next_sync_at" IS NULL
   AND "legacy_channel"."last_error_code" IS NULL
   AND "legacy_channel"."last_error_summary" IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM "ingestion_jobs" AS "monitoring_job"
      WHERE "monitoring_job"."scope_type" = 'channel'
        AND "monitoring_job"."scope_id" = "legacy_channel"."id"::text
        AND "monitoring_job"."type" IN ('channel_backfill', 'channel_poll')
   )
   AND NOT EXISTS (
     SELECT 1
       FROM "audit_events" AS "monitoring_event"
      WHERE "monitoring_event"."target_type" = 'channel'
        AND "monitoring_event"."target_id" = "legacy_channel"."id"::text
        AND "monitoring_event"."action" IN ('channel.added', 'channel.sync_queued')
   );
--> statement-breakpoint
ALTER TABLE "channel_sources" ADD COLUMN "sync_frequency" "channel_sync_frequency" DEFAULT 'daily' NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_sources" ADD COLUMN "initial_history_mode" "channel_history_mode" DEFAULT 'latest_25' NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_sources" ADD COLUMN "initial_history_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "video_sources" ADD COLUMN "unavailable_recheck_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "video_sources"
   SET "unavailable_recheck_at" = now() + interval '30 days'
 WHERE "availability" = 'unavailable' AND "unavailable_recheck_at" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "video_sources_revalidation_idx";
--> statement-breakpoint
CREATE INDEX "video_sources_revalidation_idx" ON "video_sources" USING btree ("availability", "youtube_data_expires_at", "unavailable_recheck_at");
--> statement-breakpoint
CREATE TABLE "import_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" varchar(300) NOT NULL,
  "requested_by_user_id" uuid,
  "correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "state" "import_batch_state" DEFAULT 'processing' NOT NULL,
  "total_items" integer NOT NULL,
  "queued_items" integer DEFAULT 0 NOT NULL,
  "duplicate_items" integer DEFAULT 0 NOT NULL,
  "invalid_items" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "import_batches_counts_valid" CHECK (
    "total_items" > 0 AND "queued_items" >= 0 AND "duplicate_items" >= 0
    AND "invalid_items" >= 0
    AND "queued_items" + "duplicate_items" + "invalid_items" <= "total_items"
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_idempotency_uidx" ON "import_batches" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "import_batches_created_idx" ON "import_batches" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_requested_by_user_id_users_id_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "import_batch_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "kind" varchar(40),
  "original_url" text,
  "normalized_url" text,
  "state" "import_batch_item_state" NOT NULL,
  "validation_code" varchar(80),
  "validation_summary" varchar(500),
  "duplicate_of_item_id" uuid,
  "ingestion_job_id" uuid,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "import_batch_items_ordinal_positive" CHECK ("ordinal" > 0),
  CONSTRAINT "import_batch_items_retry_nonnegative" CHECK ("retry_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "import_batch_items_ordinal_uidx" ON "import_batch_items" USING btree ("batch_id", "ordinal");
--> statement-breakpoint
CREATE INDEX "import_batch_items_job_idx" ON "import_batch_items" USING btree ("ingestion_job_id");
--> statement-breakpoint
ALTER TABLE "import_batch_items" ADD CONSTRAINT "import_batch_items_batch_id_import_batches_id_fk"
  FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "import_batch_items" ADD CONSTRAINT "import_batch_items_duplicate_of_item_id_import_batch_items_id_fk"
  FOREIGN KEY ("duplicate_of_item_id") REFERENCES "public"."import_batch_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "import_batch_items" ADD CONSTRAINT "import_batch_items_ingestion_job_id_ingestion_jobs_id_fk"
  FOREIGN KEY ("ingestion_job_id") REFERENCES "public"."ingestion_jobs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "source_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "video_id" uuid NOT NULL,
  "ingestion_job_id" uuid,
  "state" "source_review_state" DEFAULT 'open' NOT NULL,
  "parser_version" varchar(32) NOT NULL,
  "issue_fingerprint" varchar(64) NOT NULL,
  "mention_count" integer DEFAULT 0 NOT NULL,
  "warning_count" integer DEFAULT 0 NOT NULL,
  "rejected_rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ignored_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "diagnostics" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "source_reviews_counts_nonnegative" CHECK ("mention_count" >= 0 AND "warning_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "source_reviews_video_uidx" ON "source_reviews" USING btree ("video_id");
--> statement-breakpoint
CREATE INDEX "source_reviews_queue_idx" ON "source_reviews" USING btree ("state", "updated_at");
--> statement-breakpoint
ALTER TABLE "source_reviews" ADD CONSTRAINT "source_reviews_video_id_video_sources_id_fk"
  FOREIGN KEY ("video_id") REFERENCES "public"."video_sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_reviews" ADD CONSTRAINT "source_reviews_ingestion_job_id_ingestion_jobs_id_fk"
  FOREIGN KEY ("ingestion_job_id") REFERENCES "public"."ingestion_jobs"("id") ON DELETE set null ON UPDATE no action;
