import type { Task } from "graphile-worker";
import type { Pool } from "pg";
import { z } from "zod";
import { getPool } from "../db/index";
import { hasSecretLikeQueryParameter } from "../lib/validation/public-url";
import type { TaskName } from "./jobs";
import { logger } from "./logger";

type Scope = {
  scopeType: string;
  scopeId: string;
  payload: Record<string, unknown>;
  queueName?: string;
};

type EnqueuePool = Pick<Pool, "connect">;
type SchedulerPool = Pick<Pool, "connect" | "query">;

const safeSourceUrlSchema = z
  .url()
  .max(4_096)
  .refine((value) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    return !hasSecretLikeQueryParameter(url);
  }, "Source URLs in durable jobs must be public HTTP(S) URLs without credentials or secret-like query parameters.");

const durablePayloadSchemas: Record<TaskName, z.ZodType<Record<string, unknown>>> = {
  channel_resolve: z.object({
    url: safeSourceUrlSchema,
    requestedByUserId: z.uuid().optional(),
  }).strict(),
  channel_backfill: z.object({
    channelSourceId: z.uuid(),
    historyMode: z.enum(["latest_10", "latest_25", "latest_50", "since", "all"]).optional(),
    historySince: z.iso.datetime({ offset: true }).optional(),
    subscriptionJobId: z.uuid().optional(),
  }).strict().refine(
    (value) => value.historyMode !== "since" || Boolean(value.historySince),
    "A since date is required for since-mode backfills.",
  ),
  channel_poll: z.object({ channelSourceId: z.uuid() }).strict(),
  video_ingest: z.object({
    videoSourceId: z.uuid().optional(),
    url: safeSourceUrlSchema.optional(),
    parentJobId: z.uuid().optional(),
    useStoredMetadata: z.boolean().optional(),
    sourceUnavailable: z.boolean().optional(),
  }).strict()
    .refine((value) => Boolean(value.videoSourceId || value.url), "A video source ID or public URL is required."),
  youtube_revalidate: z.object({ videoSourceId: z.uuid() }).strict(),
  website_metadata: z.object({
    projectId: z.uuid().optional(),
    url: safeSourceUrlSchema,
    parentJobId: z.uuid().optional(),
  }).strict(),
  repository_resolve: z.object({
    projectId: z.uuid().optional(),
    url: safeSourceUrlSchema.optional(),
    repositoryUrl: safeSourceUrlSchema.optional(),
    query: z.string().trim().min(1).max(200).optional(),
    candidateOnly: z.boolean().optional(),
    discoveryMethod: z.string().trim().min(1).max(80).optional(),
    parentJobId: z.uuid().optional(),
  }).strict().refine(
    (value) => Boolean(value.url || value.repositoryUrl || (value.projectId && value.query)),
    "Repository resolution requires a public URL or a project search query.",
  ),
  repository_refresh: z.object({ repositoryId: z.uuid() }).strict(),
};

/** Stable, secret-free payload persisted for deterministic manual retries. */
export function durablePayloadForTask(
  task: TaskName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return durablePayloadSchemas[task].parse(payload);
}

function timeBucket(date: Date, bucketHours: number): string {
  const bucketMs = bucketHours * 60 * 60 * 1_000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
}

export async function enqueueTrackedJob(
  task: TaskName,
  scope: Scope,
  scheduleBucket: string,
  options: { pool?: EnqueuePool } = {},
): Promise<boolean> {
  const durablePayload = durablePayloadForTask(task, scope.payload);
  const idempotencyKey = `${task}:${scope.scopeType}:${scope.scopeId}:${scheduleBucket}`;
  const client = await (options.pool ?? getPool()).connect();

  try {
    await client.query("begin");
    if (
      scope.scopeType === "channel" &&
      (task === "channel_backfill" || task === "channel_poll")
    ) {
      // The advisory lock closes the race between the overdue sweep, startup
      // catch-up, and a manual sync. Graphile's queue then preserves the same
      // one-channel-at-a-time guarantee after commit.
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [`hardware:channel:${scope.scopeId}`],
      );
      const active = await client.query<{ id: string }>(
        `select id
           from ingestion_jobs
          where scope_type = 'channel'
            and scope_id = $1
            and type in ('channel_backfill', 'channel_poll')
            and state in ('queued', 'running')
          order by created_at
          limit 1`,
        [scope.scopeId],
      );
      if (active.rows[0]) {
        await client.query("rollback");
        return false;
      }
    }
    const inserted = await client.query<{
      id: string;
      correlation_id: string;
    }>(
      `
        insert into ingestion_jobs (
          type,
          state,
          idempotency_key,
          scope_type,
          scope_id,
          correlation_id,
          checkpoint,
          run_after,
          created_at,
          updated_at
        )
        values ($1, 'queued', $2, $3, $4, gen_random_uuid(), $5::jsonb, now(), now(), now())
        on conflict (idempotency_key) do nothing
        returning id, correlation_id
      `,
      [task, idempotencyKey, scope.scopeType, scope.scopeId, JSON.stringify(durablePayload)],
    );

    const tracked = inserted.rows[0];
    if (!tracked) {
      await client.query("rollback");
      return false;
    }

    // Enqueue through Graphile's SQL API on this same client so the visible
    // domain job and durable queue job commit atomically.
    const graphileResult = await client.query<{ id: string }>(
      `
        select id
        from graphile_worker.add_job(
          identifier => $1::text,
          payload => $2::json,
          queue_name => $3::text,
          max_attempts => 3,
          job_key => $4::text,
          job_key_mode => 'preserve_run_at'
        )
      `,
      [
        task,
        JSON.stringify({
          ...durablePayload,
          jobId: tracked.id,
          correlationId: tracked.correlation_id,
        }),
        scope.queueName ?? null,
        idempotencyKey,
      ],
    );
    const graphileJob = graphileResult.rows[0];
    if (!graphileJob) throw new Error("Graphile Worker did not return a job ID.");

    await client.query(
      "update ingestion_jobs set graphile_job_id = $1, updated_at = now() where id = $2",
      [graphileJob.id, tracked.id],
    );
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function scheduleOverdueChannelPolls(
  pool: SchedulerPool = getPool(),
): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `
      select id
      from channel_sources
      where enabled = true
        and state <> 'paused'
        and sync_frequency <> 'manual'
        and next_sync_at <= now()
      order by next_sync_at
    `,
  );

  const bucket = timeBucket(new Date(), 6);
  let enqueued = 0;
  for (const channel of result.rows) {
    if (
      await enqueueTrackedJob(
        "channel_poll",
        {
          scopeType: "channel",
          scopeId: channel.id,
          payload: { channelSourceId: channel.id },
          queueName: `channel:${channel.id}`,
        },
        bucket,
        { pool },
      )
    ) {
      enqueued += 1;
    }
  }

  logger.info({ event: "channel_polls_scheduled", enqueued });
  return enqueued;
}

export const scheduleChannelPolls: Task = async () => {
  await scheduleOverdueChannelPolls();
};

export const scheduleYouTubeRevalidation: Task = async () => {
  const result = await getPool().query<{ id: string }>(
    `
      with due as (
        select id, availability,
               case
                 when availability = 'unavailable' then unavailable_recheck_at
                 else coalesce(youtube_data_expires_at, created_at)
               end as due_at
          from video_sources
         where (availability = 'available' and (
                  youtube_data_expires_at is null
                  or youtube_data_expires_at <= now()
                ))
            or (availability = 'unavailable' and unavailable_recheck_at <= now())
      ), ranked as (
        select id, availability, due_at,
               row_number() over (
                 partition by availability order by due_at, id
               ) as lane_position
          from due
      )
      select id
        from ranked
       order by lane_position,
                case when availability = 'unavailable' then 0 else 1 end,
                due_at, id
      limit 500
    `,
  );

  const bucket = timeBucket(new Date(), 24);
  let enqueued = 0;
  for (const video of result.rows) {
    if (
      await enqueueTrackedJob(
        "youtube_revalidate",
        {
          scopeType: "video",
          scopeId: video.id,
          payload: { videoSourceId: video.id },
          queueName: `video:${video.id}`,
        },
        bucket,
      )
    ) {
      enqueued += 1;
    }
  }

  logger.info({ event: "youtube_revalidation_scheduled", enqueued });
};

export const scheduleRepositoryRefreshes: Task = async () => {
  const result = await getPool().query<{ id: string }>(
    `
      select id
      from repositories
      where metadata_refreshed_at is null
         or metadata_refreshed_at <= now() - interval '7 days'
      order by coalesce(metadata_refreshed_at, created_at)
      limit 500
    `,
  );

  const bucket = timeBucket(new Date(), 24);
  let enqueued = 0;
  for (const repository of result.rows) {
    if (
      await enqueueTrackedJob(
        "repository_refresh",
        {
          scopeType: "repository",
          scopeId: repository.id,
          payload: { repositoryId: repository.id },
          queueName: `repository:${repository.id}`,
        },
        bucket,
      )
    ) {
      enqueued += 1;
    }
  }

  logger.info({ event: "repository_refreshes_scheduled", enqueued });
};
