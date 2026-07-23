import { eq, sql } from "drizzle-orm";
import type { JobHelpers, Task, TaskList } from "graphile-worker";
import { getDb, getPool } from "../db/index";
import { ingestionEvents, ingestionJobs } from "../db/schema";
import {
  SafeJobError,
  safeJobError,
  taskNames,
  trackedJobPayloadSchema,
  type TaskName,
  type TrackedJobPayload,
} from "./jobs";
import { logger, safeErrorDetails } from "./logger";
import {
  scheduleChannelPolls,
  scheduleRepositoryRefreshes,
  scheduleYouTubeRevalidation,
} from "./scheduler";

export type TaskImplementation = (
  payload: TrackedJobPayload,
  helpers: JobHelpers,
) => Promise<void>;

export type TaskImplementations = Partial<Record<TaskName, TaskImplementation>>;

async function recordEvent(
  jobId: string,
  level: "info" | "warning" | "error",
  code: string,
  message: string,
): Promise<void> {
  await getDb().insert(ingestionEvents).values({
    jobId,
    level,
    code,
    message: message.slice(0, 500),
  });
}

type ChannelParentRollup = {
  finalized: boolean;
  transitioned: boolean;
  scopeId: string | null;
};

/**
 * Roll a channel parent up from its persisted children. Enumeration completion
 * is an explicit checkpoint gate, so a fast child cannot close the parent
 * while the playlist task is still discovering later pages.
 */
async function rollupChannelParent(
  parentJobId: string,
): Promise<ChannelParentRollup> {
  const result = await getPool().query<{
    scopeId: string;
    state: string;
  }>(
    `with child_stats as (
       select count(*)::int as total_items,
              count(*) filter (
                where state in ('succeeded', 'failed', 'cancelled')
              )::int as completed_items,
              count(*) filter (
                where state in ('queued', 'running')
              )::int as active_items,
              count(*) filter (
                where state in ('failed', 'cancelled')
              )::int as failed_items,
              (
                coalesce(sum(warning_count), 0)
                + coalesce(sum(
                    case when state = 'succeeded' then failure_count else 0 end
                  ), 0)
              )::int as warning_items
         from ingestion_jobs
        where type = 'video_ingest'
          and checkpoint ->> 'parentJobId' = $1::text
     ), updated_parent as (
       update ingestion_jobs parent
          set total_items = stats.total_items,
              completed_items = stats.completed_items,
              warning_count = stats.warning_items,
              failure_count = stats.failed_items,
              state = case
                when parent.checkpoint @> '{"enumerationComplete":true}'::jsonb
                  and stats.active_items = 0
                then 'succeeded'::ingestion_job_state
                else 'running'::ingestion_job_state
              end,
              finished_at = case
                when parent.checkpoint @> '{"enumerationComplete":true}'::jsonb
                  and stats.active_items = 0
                then now()
                else null
              end,
              updated_at = now()
         from child_stats stats
        where parent.id = $1::uuid
          and parent.type in ('channel_backfill', 'channel_poll')
          and parent.state = 'running'
        returning parent.scope_id as "scopeId", parent.state
     ), updated_channel as (
       update channel_sources as c
          set state = case
                when c.state = 'paused' then 'paused'::source_state
                else 'active'::source_state
              end,
              last_synced_at = now(),
              next_sync_at = case
                when c.state = 'paused'
                  or c.sync_frequency = 'manual' then null
                when c.sync_frequency = 'weekly'
                  then now() + interval '7 days'
                else now() + interval '1 day'
              end,
              last_error_code = null, last_error_summary = null,
              updated_at = now()
         from updated_parent parent
        where c.id::text = parent."scopeId"
          and parent.state = 'succeeded'
        returning c.id
     ), inserted_event as (
       insert into ingestion_events (job_id, level, code, message)
       select $1::uuid, 'info', 'CHANNEL_CHILDREN_COMPLETED',
              'All channel child jobs reached a terminal state.'
         from updated_parent
        where state = 'succeeded'
       returning id
     )
     select "scopeId", state,
            (select count(*) from updated_channel) as scheduled,
            (select count(*) from inserted_event) as event_count
       from updated_parent`,
    [parentJobId],
  );
  const transitioned = result.rows[0];
  if (!transitioned) {
    const current = await getPool().query<{ scopeId: string; state: string }>(
      `select scope_id as "scopeId", state
         from ingestion_jobs
        where id = $1::uuid
          and type in ('channel_backfill', 'channel_poll')`,
      [parentJobId],
    );
    return {
      finalized: current.rows[0]?.state === "succeeded",
      transitioned: false,
      scopeId: current.rows[0]?.scopeId ?? null,
    };
  }

  const finalized = transitioned.state === "succeeded";
  return {
    finalized,
    transitioned: finalized,
    scopeId: transitioned.scopeId,
  };
}

function trackedTask(
  name: TaskName,
  implementation?: TaskImplementation,
): Task {
  return async (rawPayload, helpers) => {
    const payload = trackedJobPayloadSchema.parse(rawPayload);
    // Graphile increments `attempts` atomically when it locks the job.
    const attempt = helpers.job.attempts;

    await getDb()
      .update(ingestionJobs)
      .set({
        state: "running",
        attempts: attempt,
        startedAt: sql`coalesce(${ingestionJobs.startedAt}, now())`,
        safeErrorCode: null,
        safeErrorSummary: null,
        updatedAt: new Date(),
      })
      .where(eq(ingestionJobs.id, payload.jobId));

    await recordEvent(
      payload.jobId,
      "info",
      "JOB_ATTEMPT_STARTED",
      `${name} attempt ${attempt} started.`,
    );

    try {
      if (!implementation) {
        throw new SafeJobError(
          "HANDLER_NOT_CONFIGURED",
          `${name} has not been connected to its ingestion service.`,
          false,
        );
      }

      await implementation(payload, helpers);
      if (name === "channel_backfill" || name === "channel_poll") {
        const rollup = await rollupChannelParent(payload.jobId);
        if (!rollup.finalized) {
          await recordEvent(
            payload.jobId,
            "info",
            "CHANNEL_CHILDREN_PENDING",
            "Channel enumeration completed; child ingestion is still active.",
          );
          logger.info({
            event: "channel_children_pending",
            task: name,
            jobId: payload.jobId,
            correlationId: payload.correlationId,
            attempt,
          });
          return;
        }
        logger.info({
          event: "job_succeeded",
          task: name,
          jobId: payload.jobId,
          correlationId: payload.correlationId,
          attempt,
        });
        return;
      }

      await getDb()
        .update(ingestionJobs)
        .set({
          state: "succeeded",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(ingestionJobs.id, payload.jobId));
      await recordEvent(
        payload.jobId,
        "info",
        "JOB_SUCCEEDED",
        `${name} completed successfully.`,
      );
      if (
        name === "video_ingest" &&
        typeof payload.parentJobId === "string"
      ) {
        await rollupChannelParent(payload.parentJobId);
      }
      logger.info({
        event: "job_succeeded",
        task: name,
        jobId: payload.jobId,
        correlationId: payload.correlationId,
        attempt,
      });
      return;
    } catch (error) {
      const safe = safeJobError(error);
      const terminal = !safe.retryable || attempt >= helpers.job.max_attempts;
      await getDb()
        .update(ingestionJobs)
        .set({
          state: terminal ? "failed" : "queued",
          safeErrorCode: safe.code,
          safeErrorSummary: safe.message,
          failureCount: sql`${ingestionJobs.failureCount} + 1`,
          finishedAt: terminal ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(ingestionJobs.id, payload.jobId));
      await recordEvent(
        payload.jobId,
        terminal ? "error" : "warning",
        safe.code,
        safe.message,
      );
      logger.error({
        event: "job_failed",
        task: name,
        jobId: payload.jobId,
        correlationId: payload.correlationId,
        attempt,
        terminal,
        code: safe.code,
        ...safeErrorDetails(error),
      });
      if (
        terminal &&
        name === "video_ingest" &&
        typeof payload.parentJobId === "string"
      ) {
        await rollupChannelParent(payload.parentJobId);
      }
      if (!safe.retryable) return;
      throw error;
    }
  };
}

export function createTaskList(
  implementations: TaskImplementations = {},
): TaskList {
  const tasks: TaskList = {
    schedule_channel_polls: scheduleChannelPolls,
    schedule_youtube_revalidation: scheduleYouTubeRevalidation,
    schedule_repository_refreshes: scheduleRepositoryRefreshes,
  };

  for (const name of taskNames) {
    tasks[name] = trackedTask(name, implementations[name]);
  }
  return tasks;
}
