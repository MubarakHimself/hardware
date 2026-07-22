import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthenticatedActor, ImportCommand, IngestionJobType } from "../domain";
import { normalizeProjectUrl } from "../ingestion";
import { getYouTubeVideoId } from "../validation";
import { getPool } from "../../db/index";
import { getServerConfig } from "./config";
import { getDemoState, type DemoQueuedImport } from "./demo-store";

const importTask: Record<ImportCommand["kind"], IngestionJobType> = {
  youtube_video: "video_ingest",
  website: "website_metadata",
  github_repository: "repository_resolve",
};

function canonicalImportUrl(input: ImportCommand): string {
  if (input.kind === "youtube_video") {
    const videoId = getYouTubeVideoId(input.url);
    if (!videoId) throw new Error("Validated YouTube URL has no video identity.");
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  const normalized = normalizeProjectUrl(input.url);
  if (!normalized.ok) {
    throw new Error(`Validated import URL failed normalization: ${normalized.code}`);
  }
  return normalized.link.canonicalUrl;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function idempotencyKey(options: {
  actorId: string;
  input: ImportCommand;
  suppliedKey?: string | null;
}): string {
  const hour = new Date().toISOString().slice(0, 13);
  return `import:${digest(
    [
      options.actorId,
      options.input.kind,
      canonicalImportUrl(options.input),
      options.suppliedKey ?? hour,
    ].join("\u0000"),
  )}`;
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
  const key = idempotencyKey({
    actorId: options.actor.userId,
    input: options.input,
    suppliedKey: options.suppliedIdempotencyKey,
  });
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const current = state.imports.get(key);
    if (current) {
      return { job: importJobDto(current, importTask[current.kind], key), created: false };
    }
    const job: DemoQueuedImport = {
      id: randomUUID(),
      kind: options.input.kind,
      url: options.input.url,
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
      scopeId: canonicalImportUrl(options.input),
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
    const task = importTask[options.input.kind];
    const scopeHash = digest(canonicalImportUrl(options.input));
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
        options.input.kind,
        scopeHash,
        options.actor.userId,
        options.correlationId,
        JSON.stringify({ url: options.input.url }),
      ],
    );
    if (inserted.rowCount === 0) {
      const current = await existingJob(client, key);
      await client.query("commit");
      return { job: importJobDto(current, task, key), created: false };
    }

    const job = inserted.rows[0];
    const graphile = await client.query<{ id: number }>(
      `select (graphile_worker.add_job(
        $1::text,
        payload := $2::json,
        max_attempts := 3,
        job_key := $3::text,
        job_key_mode := 'unsafe_dedupe'
      )).id as id`,
      [
        task,
        JSON.stringify({
          jobId: job.id,
          correlationId: options.correlationId,
          url: options.input.url,
        }),
        `hardware:${key}`,
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
        JSON.stringify({ kind: options.input.kind, scopeHash }),
      ],
    );
    await client.query("commit");
    return { job: importJobDto(job, task, key), created: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
