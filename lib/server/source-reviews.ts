import "server-only";
import { z } from "zod";
import { getPool } from "../../db/index";
import {
  SOURCE_REVIEW_STATES,
  type AuthenticatedActor,
  type IngestionJobType,
  type JobState,
} from "../domain";
import { getServerConfig } from "./config";
import { conflict, notFound, unprocessable } from "./errors";

const issueFingerprintSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "Expected issue fingerprint is invalid.");

const sourceReviewCursorSchema = z
  .object({ updatedAt: z.iso.datetime({ offset: true }), id: z.uuid() })
  .strict();

export const sourceReviewQuerySchema = z.object({
  state: z.enum(SOURCE_REVIEW_STATES).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().min(1).max(1_000).optional(),
});

export const sourceReviewUpdateSchema = z
  .object({
    state: z.enum(SOURCE_REVIEW_STATES),
    note: z.string().trim().max(2_000).optional(),
    expectedIssueFingerprint: issueFingerprintSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export interface SourceReviewDto {
  id: string;
  videoSourceId: string;
  youtubeVideoId: string;
  videoTitle: string | null;
  channelTitle: string;
  state: "open" | "resolved" | "ignored";
  parserVersion: string;
  issueFingerprint: string;
  version: number;
  mentionCount: number;
  warningCount: number;
  errorCount: number;
  rejectedRowCount: number;
  ignoredLinkCount: number;
  diagnosticCodeCounts: Record<string, number>;
  jobId: string | null;
  job: {
    id: string;
    type: IngestionJobType;
    state: JobState;
  } | null;
  resolutionNote: string | null;
  resolvedByUserId: string | null;
  resolvedByDisplayName: string | null;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface SourceReviewPageDto {
  items: SourceReviewDto[];
  nextCursor: string | null;
  totalCount: number;
  openCount: number;
}

function instant(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value ? value : null;
}

function safeDiagnosticCodeCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([code, count]) =>
          /^[A-Z0-9_]{1,80}$/u.test(code) &&
          Number.isSafeInteger(Number(count)) &&
          Number(count) >= 0,
      )
      .map(([code, count]) => [code, Number(count)]),
  );
}

function dto(row: Record<string, unknown>): SourceReviewDto {
  return {
    id: String(row.id),
    videoSourceId: String(row.videoSourceId),
    youtubeVideoId: String(row.youtubeVideoId),
    videoTitle: row.videoTitle ? String(row.videoTitle) : null,
    channelTitle: String(row.channelTitle),
    state: row.state as SourceReviewDto["state"],
    parserVersion: String(row.parserVersion),
    issueFingerprint: String(row.issueFingerprint),
    version: Number(row.version),
    mentionCount: Number(row.mentionCount),
    warningCount: Number(row.warningCount),
    errorCount: Number(row.errorCount),
    rejectedRowCount: Number(row.rejectedRowCount),
    ignoredLinkCount: Number(row.ignoredLinkCount),
    diagnosticCodeCounts: safeDiagnosticCodeCounts(row.diagnosticCodeCounts),
    jobId: row.jobId ? String(row.jobId) : null,
    job: row.jobId && row.jobType && row.jobState
      ? {
          id: String(row.jobId),
          type: row.jobType as IngestionJobType,
          state: row.jobState as JobState,
        }
      : null,
    resolutionNote: row.resolutionNote ? String(row.resolutionNote) : null,
    resolvedByUserId: row.resolvedByUserId
      ? String(row.resolvedByUserId)
      : null,
    resolvedByDisplayName: row.resolvedByDisplayName
      ? String(row.resolvedByDisplayName)
      : null,
    resolvedAt: instant(row.resolvedAt),
    updatedAt: instant(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

function encodeCursor(review: SourceReviewDto): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: review.updatedAt, id: review.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string | undefined): {
  updatedAt: string;
  id: string;
} | null {
  if (!value) return null;
  try {
    return sourceReviewCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw unprocessable(
      "invalid_source_review_cursor",
      "The source-review cursor is invalid or expired.",
    );
  }
}

export async function listSourceReviews(
  input: z.infer<typeof sourceReviewQuerySchema>,
): Promise<SourceReviewPageDto> {
  if (getServerConfig().mode === "demo") {
    return { items: [], nextCursor: null, totalCount: 0, openCount: 0 };
  }
  const cursor = decodeCursor(input.cursor);
  const [result, counts] = await Promise.all([
    getPool().query(
      `select r.id, r.video_id as "videoSourceId",
              v.youtube_video_id as "youtubeVideoId", v.title as "videoTitle",
              c.title as "channelTitle", r.state,
              r.parser_version as "parserVersion",
              r.issue_fingerprint as "issueFingerprint", r.version,
              r.mention_count as "mentionCount",
              r.warning_count as "warningCount", r.error_count as "errorCount",
              jsonb_array_length(r.rejected_rows)::int as "rejectedRowCount",
              jsonb_array_length(r.ignored_links)::int as "ignoredLinkCount",
              coalesce((
                select jsonb_object_agg(summary.code, summary.count)
                  from (
                    select diagnostic ->> 'code' as code, count(*)::int as count
                      from jsonb_array_elements(r.diagnostics) diagnostic
                     where diagnostic ->> 'code' ~ '^[A-Z0-9_]{1,80}$'
                     group by diagnostic ->> 'code'
                  ) summary
              ), '{}'::jsonb) as "diagnosticCodeCounts",
              r.ingestion_job_id as "jobId",
              j.type as "jobType", j.state as "jobState",
              r.resolution_note as "resolutionNote",
              r.resolved_by_user_id as "resolvedByUserId",
              u.display_name as "resolvedByDisplayName",
              r.resolved_at as "resolvedAt", r.updated_at as "updatedAt"
         from source_reviews r
         join video_sources v on v.id = r.video_id
         join channel_sources c on c.id = v.channel_id
         left join ingestion_jobs j on j.id = r.ingestion_job_id
         left join users u on u.id = r.resolved_by_user_id
        where r.state = $1::source_review_state
          and (
            $2::timestamptz is null
            or (r.updated_at, r.id) < ($2::timestamptz, $3::uuid)
          )
        order by r.updated_at desc, r.id desc
        limit $4`,
      [input.state, cursor?.updatedAt ?? null, cursor?.id ?? null, input.limit + 1],
    ),
    getPool().query(
      `select count(*) filter (where state = $1::source_review_state)::int
                as "totalCount",
              count(*) filter (where state = 'open')::int as "openCount"
         from source_reviews`,
      [input.state],
    ),
  ]);
  const hasMore = result.rows.length > input.limit;
  const items = result.rows.slice(0, input.limit).map(dto);
  const countRow = counts.rows[0] ?? {};
  return {
    items,
    nextCursor: hasMore && items.length > 0
      ? encodeCursor(items[items.length - 1])
      : null,
    totalCount: Number(countRow.totalCount ?? 0),
    openCount: Number(countRow.openCount ?? 0),
  };
}

export async function updateSourceReview(options: {
  actor: AuthenticatedActor;
  reviewId: string;
  state: SourceReviewDto["state"];
  note?: string;
  expectedIssueFingerprint: string;
  expectedVersion: number;
  correlationId: string;
}): Promise<{
  id: string;
  state: SourceReviewDto["state"];
  issueFingerprint: string;
  version: number;
  resolutionNote: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
}> {
  if (getServerConfig().mode === "demo") {
    return {
      id: options.reviewId,
      state: options.state,
      issueFingerprint: options.expectedIssueFingerprint,
      version: options.expectedVersion + 1,
      resolutionNote: options.state === "open" ? null : options.note ?? null,
      resolvedByUserId: options.state === "open" ? null : options.actor.userId,
      resolvedAt: options.state === "open" ? null : new Date().toISOString(),
    };
  }
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `update source_reviews
          set state = $2::source_review_state,
              version = version + 1,
              resolved_at = case when $2 = 'open' then null else now() end,
              resolved_by_user_id = case
                when $2 = 'open' then null else $3::uuid
              end,
              resolution_note = case
                when $2 = 'open' then null else nullif($4, '')
              end,
              updated_at = now()
        where id = $1::uuid
          and issue_fingerprint = $5
          and version = $6
        returning id, state, issue_fingerprint as "issueFingerprint", version,
                  resolution_note as "resolutionNote",
                  resolved_by_user_id as "resolvedByUserId",
                  resolved_at as "resolvedAt"`,
      [
        options.reviewId,
        options.state,
        options.actor.userId,
        options.note ?? null,
        options.expectedIssueFingerprint,
        options.expectedVersion,
      ],
    );
    if (!result.rows[0]) {
      const exists = await client.query(
        "select 1 from source_reviews where id = $1::uuid",
        [options.reviewId],
      );
      if (!exists.rows[0]) throw notFound("The source review does not exist.");
      throw conflict(
        "source_review_stale",
        "The source evidence changed after this review was loaded. Refresh and decide the latest version.",
      );
    }
    const row = result.rows[0];
    await client.query(
      `insert into audit_events
        (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
       values ($1::uuid, 'source_review.state_changed', 'source_review', $2,
               $3::uuid, $4::jsonb)`,
      [
        options.actor.userId,
        options.reviewId,
        options.correlationId,
        JSON.stringify({
          state: options.state,
          version: Number(row.version),
          issueFingerprint: String(row.issueFingerprint),
          hasResolutionNote: Boolean(options.note),
        }),
      ],
    );
    await client.query("commit");
    return {
      id: String(row.id),
      state: row.state as SourceReviewDto["state"],
      issueFingerprint: String(row.issueFingerprint),
      version: Number(row.version),
      resolutionNote: row.resolutionNote ? String(row.resolutionNote) : null,
      resolvedByUserId: row.resolvedByUserId
        ? String(row.resolvedByUserId)
        : null,
      resolvedAt: instant(row.resolvedAt),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
