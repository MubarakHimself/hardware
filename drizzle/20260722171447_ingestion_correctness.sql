ALTER TYPE "public"."import_batch_state" ADD VALUE 'succeeded' BEFORE 'partial';--> statement-breakpoint
ALTER TABLE "source_reviews" ADD COLUMN "resolved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "source_reviews" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "source_reviews" ADD CONSTRAINT "source_reviews_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;