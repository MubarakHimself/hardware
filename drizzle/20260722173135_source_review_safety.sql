ALTER TABLE "source_reviews" DROP CONSTRAINT "source_reviews_counts_nonnegative";--> statement-breakpoint
ALTER TABLE "source_reviews" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_reviews" ADD COLUMN "error_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "source_reviews" AS review
   SET "warning_count" = (
         SELECT count(*)::int
           FROM jsonb_array_elements(review."diagnostics") AS diagnostic
          WHERE diagnostic ->> 'severity' = 'warning'
       ),
       "error_count" = (
         SELECT count(*)::int
           FROM jsonb_array_elements(review."diagnostics") AS diagnostic
          WHERE diagnostic ->> 'severity' = 'error'
       );--> statement-breakpoint
ALTER TABLE "source_reviews" ADD CONSTRAINT "source_reviews_version_positive" CHECK ("source_reviews"."version" > 0);--> statement-breakpoint
ALTER TABLE "source_reviews" ADD CONSTRAINT "source_reviews_counts_nonnegative" CHECK ("source_reviews"."mention_count" >= 0 and "source_reviews"."warning_count" >= 0 and "source_reviews"."error_count" >= 0);
