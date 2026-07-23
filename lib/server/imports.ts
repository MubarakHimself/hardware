import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthenticatedActor, ImportCommand, IngestionJobType } from "../domain";
import { normalizeProjectUrl } from "../ingestion";
import { getYouTubeChannelImportIdentity, getYouTubeVideoId } from "../validation";
import { parseImportRequest } from "../validation/imports";
import { getPool } from "../../db/index";
import { getServerConfig } from "./config";
import { getDemoState, type DemoQueuedImport } from "./demo-store";

const importTask: Record<ImportCommand["kind"], IngestionJobType> = {
  youtube_video: "video_ingest",
  youtube_channel: "channel_resolve",
  website: "website_metadata",
  github_repository: "repository_resolve",
};

export function canonicalImportUrl(input: ImportCommand): string {
  if (input.kind === "youtube_video") {
    const videoId = getYouTubeVideoId(input.url);
    if (!videoId) throw new Error("Validated YouTube URL has no video identity.");
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  if (input.kind === "youtube_channel") {
    const channel = getYouTubeChannelImportIdentity(input.url);
    if (!channel) throw new Error("Validated YouTube channel URL has no identity.");
    return channel.canonicalUrl;
  }
  const normalized = normalizeProjectUrl(input.url);
  if (!normalized.ok) {
    throw new Error(`Validated import URL failed normalization: ${normalized.code}`);
  }
  return normalized.link.canonicalUrl;
}

export function importDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function idempotencyKey(options: {
  actorId: string;
  input: ImportCommand;
}): string {
  return `import:${importDigest(
    [
      options.actorId,
      options.input.kind,
      canonicalImportUrl(options.input),
    ].join("\u0000"),
  )}`;
}

export async function queueImportWithClient(
  client: PoolClient,
  options: {
    actor: AuthenticatedActor;
    input: ImportCommand;
    correlationId: string;
    suppliedIdempotencyKey?: string | null;
  },
): Promise<{ job: ImportJobDto; created: boolean }> {
  // These helpers are also called outside the HTTP route. Re-validate at the
  // queue boundary so a typed-but-untrusted runtime value cannot bypass URL
  // policy and reach persistence or provider work.
  const input = parseImportRequest(options.input);
  const key = idempotencyKey({
    actorId: options.actor.userId,
    input,
  });
  const task = importTask[input.kind];
  const canonicalUrl = canonicalImportUrl(input);
  const scopeHash = importDigest(canonicalUrl);
  const semanticExisting = await client.query(
    `select id, type, state, idempotency_key as "idempotencyKey",
            correlation_id as "correlationId", created_at as "createdAt"
       from ingestion_jobs
      where scope_type = $1 and scope_id = $2
      order by case state
        when 'running' then 0
        when 'queued' then 1
        when 'succeeded' then 2
        when 'failed' then 3
        else 4
      end, created_at desc
      limit 1
      for update`,
    [input.kind, scopeHash],
  );
  if (semanticExisting.rows[0]) {
    return {
      job: importJobDto(semanticExisting.rows[0], task, String(semanticExisting.rows[0].idempotencyKey)),
      created: false,
    };
  }
  const inserted = await client.query(
    `insert into ingestion_jobs
      (type, idempotency_key, scope_type, scope_id, requested_by_user_id,
       correlation_id, checkpoint)
     values ($1, $2, $3, $4, $5::uuid, $6::uuid, $7::jsonb)
     on conflict (idempotency_key) do nothing
     returning id, type, state, idempotency_key as "idempotencyKey",
               correlation_id as "correlationId", created_at as "createdAt"`,
    [
      task,
      key,
      input.kind,
      scopeHash,
      options.actor.userId,
      options.correlationId,
      JSON.stringify({
        url: canonicalUrl,
        ...(input.kind === "youtube_channel"
          ? { requestedByUserId: options.actor.userId }
          : {}),
      }),
    ],
  );
  if (inserted.rowCount === 0) {
    const current = await existingJob(client, key);
    return { job: importJobDto(current, task, key), created: false };
  }

  const job = inserted.rows[0];
  const queueName = input.kind === "youtube_video"
    ? `youtube:${getYouTubeVideoId(canonicalUrl)}`
    : `source:${scopeHash.slice(0, 40)}`;
  const graphile = await client.query<{ id: number }>(
    `select (graphile_worker.add_job(
      $1::text,
      payload := $2::json,
      max_attempts := 3,
      job_key := $3::text,
      job_key_mode := 'unsafe_dedupe',
      queue_name := $4::text
    )).id as id`,
    [
      task,
      JSON.stringify({
        jobId: job.id,
        correlationId: options.correlationId,
        url: canonicalUrl,
        ...(input.kind === "youtube_channel"
          ? { requestedByUserId: options.actor.userId }
          : {}),
      }),
      `hardware:${key}`,
      queueName,
    ],
  );
  await client.query(
    "update ingestion_jobs set graphile_job_id = $1 where id = $2::uuid",
    [graphile.rows[0]?.id ?? null, job.id],
  );
  await client.query(
    `insert into audit_events
       (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
     values ($1::uuid, 'import.queued', 'ingestion_job', $2, $3::uuid, $4::jsonb)`,
    [
      options.actor.userId,
      job.id,
      options.correlationId,
      JSON.stringify({ kind: input.kind, scopeHash }),
    ],
  );
  return { job: importJobDto(job, task, key), created: true };
}

async function existingJob(client: PoolClient, key: string) {
  const result = await client.query(
    `select id, type, state, idempotency_key as "idempotencyKey",
            correlation_id as "correlationId", created_at as "createdAt"
       from ingestion_jobs where idempotency_key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

export interface ImportJobDto {
  id: string;
  type: IngestionJobType;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  idempotencyKey: string;
  correlationId: string;
  createdAt: string;
}

function importJobDto(
  job: Record<string, unknown> | DemoQueuedImport,
  type: IngestionJobType,
  key: string,
): ImportJobDto {
  const createdAt = job.createdAt;
  return {
    id: String(job.id),
    type,
    state: String(job.state) as ImportJobDto["state"],
    idempotencyKey: key,
    correlationId: String(job.correlationId),
    createdAt:
      createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
  };
}

export async function queueImport(options: {
  actor: AuthenticatedActor;
  input: ImportCommand;
  correlationId: string;
  suppliedIdempotencyKey?: string | null;
}): Promise<{ job: ImportJobDto; created: boolean }> {
  // Reject unsupported inputs before selecting a runtime or opening a database
  // connection. HTTP routes validate too, but this is the authoritative server
  // queue boundary for direct calls and batch handoff.
  const input = parseImportRequest(options.input);
  const key = idempotencyKey({
    actorId: options.actor.userId,
    input,
  });
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const current = state.imports.get(key);
    if (current) {
      return { job: importJobDto(current, importTask[current.kind], key), created: false };
    }
    const job: DemoQueuedImport = {
      id: randomUUID(),
      kind: input.kind,
      url: input.url,
      state: "queued",
      correlationId: options.correlationId,
      createdAt: new Date().toISOString(),
    };
    state.imports.set(key, job);
    state.jobs.set(job.id, {
      id: job.id,
      idempotencyKey: key,
      type: importTask[job.kind],
      state: "queued",
      scopeType: job.kind,
      scopeId: canonicalImportUrl(input),
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
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      startedAt: null,
      finishedAt: null,
    });
    return { job: importJobDto(job, importTask[job.kind], key), created: true };
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const queued = await queueImportWithClient(client, { ...options, input });
    await client.query("commit");
    return queued;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
