-- Consolidate any legacy invite-only accounts into the one durable local owner.
-- Ownership and audit foreign keys remain intact; private state is preserved.
DROP INDEX IF EXISTS "users_clerk_user_id_uidx";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "clerk_user_id" DROP NOT NULL;--> statement-breakpoint
INSERT INTO "users" (
  "id", "clerk_user_id", "display_name", "role", "last_seen_at", "deleted_at"
) VALUES (
  '00000000-0000-4000-8000-000000000001'::uuid,
  NULL,
  'Local owner',
  'admin',
  now(),
  NULL
)
ON CONFLICT ("id") DO UPDATE
SET "display_name" = COALESCE("users"."display_name", EXCLUDED."display_name"),
    "role" = 'admin',
    "last_seen_at" = now(),
    "deleted_at" = NULL,
    "updated_at" = now();--> statement-breakpoint

-- Notes and preferences have owner/project primary keys, so merge those rows
-- before remapping simpler foreign keys.
-- Widen note storage first: several valid 10,000-character legacy notes may
-- collapse into one owner/project row, and migration must not truncate them.
ALTER TABLE "project_notes" ALTER COLUMN "body" TYPE text;--> statement-breakpoint
INSERT INTO "project_notes" (
  "owner_user_id", "project_id", "body", "version", "created_at", "updated_at"
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  "project_id",
  string_agg("body", E'\n\n---\n\n' ORDER BY "updated_at" DESC, "owner_user_id"),
  max("version"),
  min("created_at"),
  max("updated_at")
FROM "project_notes"
WHERE "owner_user_id" <> '00000000-0000-4000-8000-000000000001'::uuid
GROUP BY "project_id"
ON CONFLICT ("owner_user_id", "project_id") DO UPDATE
SET "body" = "project_notes"."body" || E'\n\n---\n\n' || EXCLUDED."body",
    "version" = greatest("project_notes"."version", EXCLUDED."version") + 1,
    "updated_at" = greatest("project_notes"."updated_at", EXCLUDED."updated_at");--> statement-breakpoint
DELETE FROM "project_notes"
WHERE "owner_user_id" <> '00000000-0000-4000-8000-000000000001'::uuid;--> statement-breakpoint

INSERT INTO "project_preferences" (
  "owner_user_id", "project_id", "is_impressive", "created_at", "updated_at"
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  "project_id",
  bool_or("is_impressive"),
  min("created_at"),
  max("updated_at")
FROM "project_preferences"
WHERE "owner_user_id" <> '00000000-0000-4000-8000-000000000001'::uuid
GROUP BY "project_id"
ON CONFLICT ("owner_user_id", "project_id") DO UPDATE
SET "is_impressive" = "project_preferences"."is_impressive" OR EXCLUDED."is_impressive",
    "updated_at" = greatest("project_preferences"."updated_at", EXCLUDED."updated_at");--> statement-breakpoint
DELETE FROM "project_preferences"
WHERE "owner_user_id" <> '00000000-0000-4000-8000-000000000001'::uuid;--> statement-breakpoint

-- Collection names were unique per account. Temporarily remove that index,
-- remap ownership, and suffix only genuine collisions with the lowest
-- available deterministic number.
DROP INDEX IF EXISTS "collections_owner_name_uidx";--> statement-breakpoint
UPDATE "collections"
SET "owner_user_id" = '00000000-0000-4000-8000-000000000001'::uuid,
    "visibility" = 'private',
    "updated_at" = now()
WHERE "owner_user_id" <> '00000000-0000-4000-8000-000000000001'::uuid
   OR "visibility" <> 'private';--> statement-breakpoint
DO $$
DECLARE
  duplicate_collection record;
  candidate_name text;
  suffix_number integer;
  suffix_text text;
BEGIN
  FOR duplicate_collection IN
    SELECT ranked."id", ranked."name", ranked."created_at", ranked.duplicate_number
    FROM (
      SELECT "id", "name", "created_at",
             row_number() OVER (
               PARTITION BY "owner_user_id", "name"
               ORDER BY "created_at", "id"
             ) AS duplicate_number
      FROM "collections"
    ) AS ranked
    WHERE ranked.duplicate_number > 1
    ORDER BY ranked."name" COLLATE "C", ranked."created_at", ranked."id"
  LOOP
    suffix_number := duplicate_collection.duplicate_number;
    LOOP
      suffix_text := ' (' || suffix_number::text || ')';
      candidate_name := left(
        duplicate_collection."name",
        160 - length(suffix_text)
      ) || suffix_text;
      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM "collections" AS occupied
        WHERE occupied."id" <> duplicate_collection."id"
          AND occupied."owner_user_id" = '00000000-0000-4000-8000-000000000001'::uuid
          AND occupied."name" = candidate_name
      );
      suffix_number := suffix_number + 1;
    END LOOP;

    UPDATE "collections"
    SET "name" = candidate_name,
        "updated_at" = now()
    WHERE "id" = duplicate_collection."id";
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "collections_owner_name_uidx"
ON "collections" USING btree ("owner_user_id", "name");--> statement-breakpoint

UPDATE "channel_sources"
SET "created_by_user_id" = '00000000-0000-4000-8000-000000000001'::uuid
WHERE "created_by_user_id" IS NOT NULL
  AND "created_by_user_id" <> '00000000-0000-4000-8000-000000000001'::uuid;--> statement-breakpoint
UPDATE "repository_candidates"
SET "reviewed_by_user_id" = '00000000-0000-4000-8000-000000000001'::uuid
WHERE "reviewed_by_user_id" IS NOT NULL
  AND "reviewed_by_user_id" <> '00000000-0000-4000-8000-000000000001'::uuid;--> statement-breakpoint
UPDATE "collection_projects"
SET "added_by_user_id" = '00000000-0000-4000-8000-000000000001'::uuid
WHERE "added_by_user_id" IS NOT NULL
  AND "added_by_user_id" <> '00000000-0000-4000-8000-000000000001'::uuid;--> statement-breakpoint
UPDATE "ingestion_jobs"
SET "requested_by_user_id" = '00000000-0000-4000-8000-000000000001'::uuid
WHERE "requested_by_user_id" IS NOT NULL
  AND "requested_by_user_id" <> '00000000-0000-4000-8000-000000000001'::uuid;--> statement-breakpoint
UPDATE "audit_events"
SET "actor_user_id" = '00000000-0000-4000-8000-000000000001'::uuid
WHERE "actor_user_id" IS NOT NULL
  AND "actor_user_id" <> '00000000-0000-4000-8000-000000000001'::uuid;--> statement-breakpoint

DELETE FROM "users"
WHERE "id" <> '00000000-0000-4000-8000-000000000001'::uuid;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "clerk_user_id";
