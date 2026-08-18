import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPool } from "../../db/index";
import type {
  AuthenticatedActor,
  IngestionJobType,
  JobState,
} from "../domain";
import { normalizeProjectUrl } from "../ingestion";
import { getServerConfig } from "./config";
import { getDemoState } from "./demo-store";
import { conflict, notFound } from "./errors";
import { addTrackedGraphileJob } from "./job-queue";
import { findActiveChannelJob, lockChannelJobLane } from "./channel-jobs";
import type { DemoStoredJob } from "./demo-store";
import { requireTaskProviderConfigured } from "./providers";

export interface JobDto {
  id: string;
  type: IngestionJobType;
  state: JobState;
  scopeType: string;
  scopeId: string;
  attempts: number;
  maxAttempts: number;
  totalItems: number;
  completedItems: number;
  warningCount: number;
  failureCount: number;
  safeErrorCode: string | null;
  safeErrorSummary: string | null;
  requestedByMe: boolean;
  canRetry: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function instant(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

function jobDto(
  row: Record<string, unknown>,
  actor: AuthenticatedActor,
): JobDto {
  const state = String(row.state) as JobState;
  return {
    id: String(row.id),
    type: String(row.type) as IngestionJobType,
    state,
    scopeType: String(row.scopeType ?? "unknown"),
    scopeId: String(row.scopeId ?? ""),
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.maxAttempts ?? 3),
    totalItems: Number(row.totalItems ?? 0),
    completedItems: Number(row.completedItems ?? 0),
    warningCount: Number(row.warningCount ?? 0),
    failureCount: Number(row.failureCount ?? 0),
    safeErrorCode:
      typeof row.safeErrorCode === "string" ? row.safeErrorCode : null,
    safeErrorSummary:
      typeof row.safeErrorSummary === "string" ? row.safeErrorSummary : null,
    requestedByMe: row.requestedByUserId === actor.userId,
    canRetry: actor.role === "admin" && state === "failed",
    createdAt: instant(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: instant(row.updatedAt) ?? instant(row.createdAt) ?? new Date(0).toISOString(),
    startedAt: instant(row.startedAt),
    finishedAt: instant(row.finishedAt),
  };
}

export async function listJobs(options: {
  actor: AuthenticatedActor;
  limit: number;
}): Promise<JobDto[]> {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const stored = [...state.jobs.values()];
    if (options.actor.role === "admin") {
      for (const channel of state.channels.filter(
        (item) => item.status === "attention",
      )) {
        const id = `failed-${channel.id}`;
        if (state.jobs.has(id)) continue;
        stored.push({
          id,
          idempotencyKey: `demo:${id}`,
          type: "channel_poll",
          state: "failed",
          scopeType: "channel",
          scopeId: channel.id,
          requestedByUserId: null,
          correlationId: "00000000-0000-4000-8000-000000000099",
          attempts: 3,
          maxAttempts: 3,
          totalItems: channel.videos,
          completedItems: Math.max(0, channel.videos - 2),
          warningCount: 1,
          failureCount: 2,
          safeErrorCode: "YOUTUBE_QUOTA_TEMPORARY",
          safeErrorSummary:
            "The source could not finish after bounded retries.",
          createdAt: "2026-07-22T05:00:00.000Z",
          updatedAt: "2026-07-22T05:12:00.000Z",
          startedAt: "2026-07-22T05:00:04.000Z",
          finishedAt: "2026-07-22T05:12:00.000Z",
        });
      }
    }
    return stored
      .filter(
        (row) =>
          options.actor.role === "admin" ||
          row.requestedByUserId === options.actor.userId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit)
      .map((row) => jobDto(row as unknown as Record<string, unknown>, options.actor));
  }

  const result = await getPool().query(
    `select id, type, state, scope_type as "scopeType", scope_id as "scopeId",
            requested_by_user_id as "requestedByUserId", attempts,
            max_attempts as "maxAttempts", total_items as "totalItems",
            completed_items as "completedItems", warning_count as "warningCount",
            failure_count as "failureCount", safe_error_code as "safeErrorCode",
            safe_error_summary as "safeErrorSummary", created_at as "createdAt",
            updated_at as "updatedAt", started_at as "startedAt",
            finished_at as "finishedAt"
       from ingestion_jobs
      where ($2::boolean or requested_by_user_id = $1::uuid)
      order by created_at desc, id desc
      limit $3`,
    [options.actor.userId, options.actor.role === "admin", options.limit],
  );
  return result.rows.map((row) => jobDto(row, options.actor));
}

export async function queueProjectMetadataRefresh(options: {
  actor: AuthenticatedActor;
  projectId: string;
  correlationId: string;
}): Promise<{ projectId: string; jobs: JobDto[] }> {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const project = state.projects.find((item) => item.id === options.projectId);
    if (!project) throw notFound("The project does not exist.");
    const now = new Date().toISOString();
    const bucket = now.slice(0, 13);
    const rows: DemoStoredJob[] = [];
    let created = false;
    const addDemoJob = (
      type: IngestionJobType,
      scopeType: string,
      scopeId: string,
    ) => {
      const idempotencyKey =
        `project:${project.id}:manual-refresh:${type}:${bucket}`;
      const existing = [...state.jobs.values()].find(
        (job) => job.idempotencyKey === idempotencyKey,
      );
      if (existing) {
        rows.push(existing);
        return;
      }
      const row: DemoStoredJob = {
        id: randomUUID(),
        idempotencyKey,
        type,
        state: "queued",
        scopeType,
        scopeId,
        requestedByUserId: options.actor.userId,
        correlationId: options.correlationId,
        attempts: 0,
        maxAttempts: 3,
        totalItems: 0,
        completedItems: 0,
        warningCount: 0,
        failureCount: 0,
        safeErrorCode: null,
        safeErrorSummary: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      };
      state.jobs.set(row.id, row);
      rows.push(row);
      created = true;
    };
    if (project.primaryUrl) {
      addDemoJob("website_metadata", "project", project.id);
    }
    if (project.repositoryState === "verified" && project.repositoryUrl) {
      addDemoJob(
        "repository_refresh",
        "repository",
        `demo-repository-${project.id}`,
      );
    }
    if (!rows.length) {
      throw conflict(
        "metadata_source_missing",
        "This project has no website or verified repository to refresh.",
      );
    }
    if (created) {
      state.audit.push({
        action: "project.metadata_refresh_queued",
        targetId: project.id,
        actorId: options.actor.userId,
        correlationId: options.correlationId,
        createdAt: now,
      });
    }
    return {
      projectId: project.id,
      jobs: rows.map((row) =>
        jobDto(row as unknown as Record<string, unknown>, options.actor),
      ),
    };
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const selected = await client.query(
      `select p.id, p.primary_url as "primaryUrl",
              p.primary_repository_id as "repositoryId"
         from projects p
        where (p.id::text = $1 or p.slug = $1) and p.state = 'active'
        for update`,
      [options.projectId],
    );
    const project = selected.rows[0];
    if (!project) throw notFound("The project does not exist.");
    const tasks: Array<{
      task: IngestionJobType;
      scopeType: string;
      scopeId: string;
      payload: Record<string, unknown>;
    }> = [];
    if (project.primaryUrl) {
      const normalized = normalizeProjectUrl(String(project.primaryUrl));
      if (normalized.ok) {
        tasks.push({
          task: "website_metadata",
          scopeType: "project",
          scopeId: String(project.id),
          payload: {
            projectId: String(project.id),
            url: normalized.link.canonicalUrl,
          },
        });
      }
    }
    if (project.repositoryId) {
      tasks.push({
        task: "repository_refresh",
        scopeType: "repository",
        scopeId: String(project.repositoryId),
        payload: { repositoryId: String(project.repositoryId) },
      });
    }
    if (!tasks.length) {
      throw conflict(
        "metadata_source_missing",
        "This project has no refreshable public metadata source.",
      );
    }

    const rows: Record<string, unknown>[] = [];
    const createdRows: Record<string, unknown>[] = [];
    const bucket = new Date().toISOString().slice(0, 13);
    for (const task of tasks) {
      const key =
        `project:${project.id}:manual-refresh:${task.task}:${bucket}`;
      const inserted = await client.query(
        `insert into ingestion_jobs
           (type, idempotency_key, scope_type, scope_id,
            requested_by_user_id, correlation_id, checkpoint)
         values ($1, $2, $3, $4, $5::uuid, $6::uuid, $7::jsonb)
         on conflict (idempotency_key) do nothing
         returning id, type, state, scope_type as "scopeType",
                   scope_id as "scopeId", requested_by_user_id as "requestedByUserId",
                   attempts, max_attempts as "maxAttempts",
                   total_items as "totalItems", completed_items as "completedItems",
                   warning_count as "warningCount", failure_count as "failureCount",
                   safe_error_code as "safeErrorCode",
                   safe_error_summary as "safeErrorSummary",
                   created_at as "createdAt", updated_at as "updatedAt",
                   started_at as "startedAt", finished_at as "finishedAt"`,
        [
          task.task,
          key,
          task.scopeType,
          task.scopeId,
          options.actor.userId,
          options.correlationId,
          JSON.stringify(task.payload),
        ],
      );
      let row = inserted.rows[0];
      if (row) {
        createdRows.push(row);
        const graphileId = await addTrackedGraphileJob(client, {
          task: task.task,
          jobId: row.id,
          correlationId: options.correlationId,
          jobKey: `hardware:manual-refresh:${row.id}`,
          payload: task.payload,
        });
        await client.query(
          "update ingestion_jobs set graphile_job_id = $1 where id = $2::uuid",
          [graphileId, row.id],
        );
      } else {
        const current = await client.query(
          `select id, type, state, scope_type as "scopeType",
                  scope_id as "scopeId", requested_by_user_id as "requestedByUserId",
                  attempts, max_attempts as "maxAttempts",
                  total_items as "totalItems", completed_items as "completedItems",
                  warning_count as "warningCount", failure_count as "failureCount",
                  safe_error_code as "safeErrorCode",
                  safe_error_summary as "safeErrorSummary",
                  created_at as "createdAt", updated_at as "updatedAt",
                  started_at as "startedAt", finished_at as "finishedAt"
             from ingestion_jobs where idempotency_key = $1`,
          [key],
        );
        row = current.rows[0];
      }
      rows.push(row);
    }
    if (createdRows.length) {
      await client.query(
        `insert into audit_events
         (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
       values ($1::uuid, 'project.metadata_refresh_queued', 'project', $2, $3::uuid, $4::jsonb)`,
        [
          options.actor.userId,
          project.id,
          options.correlationId,
          JSON.stringify({
            jobIds: createdRows.map((row) => row.id),
            tasks: createdRows.map((row) => row.type),
          }),
        ],
      );
    }
    await client.query("commit");
    return {
      projectId: String(project.id),
      jobs: rows.map((row) => jobDto(row, options.actor)),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function retryJob(options: {
  actor: AuthenticatedActor;
  jobId: string;
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const stored = getDemoState().jobs.get(options.jobId);
    if (stored) {
      if (stored.state === "queued" || stored.state === "running") {
        return { id: stored.id, state: stored.state, created: false };
      }
      if (stored.state !== "failed") {
        throw conflict("job_not_retryable", "Only a terminal failed job can be retried.");
      }
      stored.state = "queued";
      stored.attempts = 0;
      stored.safeErrorCode = null;
      stored.safeErrorSummary = null;
      stored.startedAt = null;
      stored.finishedAt = null;
      stored.updatedAt = new Date().toISOString();
      return { id: stored.id, state: "queued", created: true };
    }
    const match = options.jobId.match(/^failed-(.+)$/);
    const channel = match
      ? getDemoState().channels.find((item) => item.id === match[1])
      : undefined;
    if (!channel) throw notFound("The failed job does not exist.");
    channel.status = "syncing";
    channel.progress = 0;
    channel.progressLabel = "Retry queued";
    const now = new Date().toISOString();
    getDemoState().jobs.set(options.jobId, {
      id: options.jobId,
      idempotencyKey: `demo:retry:${options.jobId}`,
      type: "channel_poll",
      state: "queued",
      scopeType: "channel",
      scopeId: channel.id,
      requestedByUserId: options.actor.userId,
      correlationId: options.correlationId,
      attempts: 0,
      maxAttempts: 3,
      totalItems: channel.videos,
      completedItems: 0,
      warningCount: 0,
      failureCount: 0,
      safeErrorCode: null,
      safeErrorSummary: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    });
    return { id: options.jobId, state: "queued", created: true };
  }
  z.string().uuid().parse(options.jobId);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `select id, type, state, correlation_id, scope_type, scope_id, checkpoint
         from ingestion_jobs
        where id = $1::uuid for update`,
      [options.jobId],
    );
    const job = result.rows[0];
    if (!job) throw notFound("The ingestion job does not exist.");
    requireTaskProviderConfigured(job.type as IngestionJobType);
    if (job.state === "queued" || job.state === "running") {
      await client.query("commit");
      return { id: job.id, state: job.state, created: false };
    }
    if (job.state !== "failed") {
      throw conflict("job_not_retryable", "Only a terminal failed job can be retried.");
    }
    const isChannelJob =
      job.type === "channel_backfill" || job.type === "channel_poll";
    if (isChannelJob) {
      await lockChannelJobLane(client, String(job.scope_id));
      const activeJob = await findActiveChannelJob(
        client,
        String(job.scope_id),
        String(job.id),
      );
      if (activeJob) {
        await client.query("commit");
        return {
          id: activeJob.id,
          state: activeJob.state,
          created: false,
        };
      }
    }
    const retryPayload: Record<string, unknown> =
      job.checkpoint && typeof job.checkpoint === "object" ? job.checkpoint : {};
    if (isChannelJob) {
      retryPayload.channelSourceId = job.scope_id;
      delete retryPayload.enumerationComplete;
    } else if (
      (job.type === "video_ingest" || job.type === "youtube_revalidate") &&
      job.scope_type === "video"
    ) {
      retryPayload.videoSourceId = job.scope_id;
    } else if (job.type === "repository_refresh") {
      retryPayload.repositoryId = job.scope_id;
    }
    const graphileId = await addTrackedGraphileJob(client, {
      task: job.type as IngestionJobType,
      jobId: job.id,
      correlationId: options.correlationId,
      jobKey: `hardware:retry:${job.id}:${randomUUID()}`,
      queueName: isChannelJob
        ? `channel:${job.scope_id}`
        : job.type === "video_ingest" || job.type === "youtube_revalidate"
          ? `video:${job.scope_id}`
          : undefined,
      payload: retryPayload,
    });
    await client.query(
      `update ingestion_jobs set state = 'queued', attempts = 0,
        graphile_job_id = $1, safe_error_code = null, safe_error_summary = null,
        checkpoint = $3::jsonb, started_at = null, finished_at = null,
        updated_at = now()
       where id = $2::uuid`,
      [graphileId, job.id, JSON.stringify(retryPayload)],
    );
    if (
      (job.type === "video_ingest" || job.type === "youtube_revalidate") &&
      typeof retryPayload.parentJobId === "string"
    ) {
      await client.query(
        `update ingestion_jobs
            set state = 'running', finished_at = null, updated_at = now()
          where id = $1::uuid
            and type in ('channel_backfill', 'channel_poll')
            and state = 'succeeded'`,
        [retryPayload.parentJobId],
      );
    }
    await client.query(
      `insert into audit_events
        (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
       values ($1::uuid, 'job.retry_queued', 'ingestion_job', $2, $3::uuid, $4::jsonb)`,
      [options.actor.userId, job.id, options.correlationId, JSON.stringify({ state: "queued" })],
    );
    await client.query("commit");
    return { id: job.id, state: "queued", created: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
