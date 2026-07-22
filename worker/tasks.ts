import { eq, sql } from "drizzle-orm";
import type { JobHelpers, Task, TaskList } from "graphile-worker";
import { getDb } from "../db/index";
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
      logger.info({
        event: "job_succeeded",
        task: name,
        jobId: payload.jobId,
        correlationId: payload.correlationId,
        attempt,
      });
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
