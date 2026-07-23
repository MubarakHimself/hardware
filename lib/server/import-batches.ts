import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { getPool } from "../../db/index";
import type {
  AuthenticatedActor,
  ImportBatchItemState,
  ImportBatchState,
  ImportKind,
  JobState,
} from "../domain";
import {
  importBatchRequestSchema,
  validateImportBatchItems,
  type ValidatedBatchItem,
} from "../validation";
import { getServerConfig } from "./config";
import { conflict, notFound } from "./errors";
import {
  importDigest,
  queueImport,
  queueImportWithClient,
} from "./imports";
import { retryJob } from "./jobs";

export const importBatchIdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .optional();

export interface ImportBatchItemDto {
  id: string;
  ordinal: number;
  kind: ImportKind | null;
  originalUrl: string | null;
  normalizedUrl: string | null;
  state: ImportBatchItemState | JobState;
  validationCode: string | null;
  validationSummary: string | null;
  duplicateOfItemId: string | null;
  jobId: string | null;
  jobState: JobState | null;
  retryCount: number;
}

export interface ImportBatchDto {
  id: string;
  state: ImportBatchState;
  totalItems: number;
  queuedItems: number;
  duplicateItems: number;
  invalidItems: number;
  correlationId: string;
  createdAt: string;
  items: ImportBatchItemDto[];
}

const demoBatches = new Map<string, ImportBatchDto>();
const demoBatchKeys = new Map<string, string>();

function batchKey(options: {
  actorId: string;
  items: unknown[];
  suppliedKey?: string | null;
}): string {
  const normalizedItems = validateImportBatchItems(options.items).map((item) => ({
    kind: item.input?.kind ?? item.kind,
    url: item.normalizedUrl ?? item.originalUrl,
    validationCode: item.validationCode,
  }));
  const requestIdentity =
    options.suppliedKey ?? importDigest(JSON.stringify(normalizedItems));
  return `batch:${importDigest(`${options.actorId}\u0000${requestIdentity}`)}`;
}

export function deriveImportBatchState(
  queued: number,
  duplicate: number,
  invalid: number,
): ImportBatchState {
  if (queued + duplicate === 0 && invalid > 0) return "failed";
  if (invalid > 0) return "partial";
  return "queued";
}

export function deriveCurrentImportBatchState(
  items: Array<{
    submissionState: ImportBatchItemState;
    jobState: JobState | null;
  }>,
): ImportBatchState {
  const executable = items.filter((item) => item.submissionState === "queued");
  const active = executable.filter(
    (item) =>
      item.jobState === null ||
      item.jobState === "queued" ||
      item.jobState === "running",
  ).length;
  const succeeded = executable.filter(
    (item) => item.jobState === "succeeded",
  ).length;
  const failed = executable.filter(
    (item) => item.jobState === "failed" || item.jobState === "cancelled",
  ).length;
  const duplicate = items.filter(
    (item) => item.submissionState === "duplicate",
  ).length;
  const invalid = items.filter(
    (item) => item.submissionState === "invalid",
  ).length;

  if (active > 0) return failed > 0 || invalid > 0 ? "partial" : "queued";
  if (failed > 0 || invalid > 0) {
    return succeeded > 0 || duplicate > 0 ? "partial" : "failed";
  }
  return "succeeded";
}

export function previewImportBatch(items: unknown[]) {
  return validateImportBatchItems(items).map((item) => ({
    ordinal: item.ordinal,
    kind: item.input?.kind ?? item.kind,
    originalUrl: item.originalUrl,
    normalizedUrl: item.normalizedUrl,
    state: !item.input
      ? "invalid" as const
      : item.duplicateOfOrdinal !== null
        ? "duplicate" as const
        : "ready" as const,
    duplicateOfOrdinal: item.duplicateOfOrdinal,
    validationCode: item.validationCode,
    validationSummary: item.validationSummary,
  }));
}

type Queryable = Pick<PoolClient, "query">;

async function readBatch(
  queryable: Queryable,
  batchId: string,
): Promise<ImportBatchDto | null> {
  const [batchResult, itemResult] = await Promise.all([
    queryable.query(
      `select id, state, total_items as "totalItems",
              queued_items as "queuedItems", duplicate_items as "duplicateItems",
              invalid_items as "invalidItems", correlation_id as "correlationId",
              created_at as "createdAt"
         from import_batches where id = $1::uuid`,
      [batchId],
    ),
    queryable.query(
      `select i.id, i.ordinal, i.kind, i.original_url as "originalUrl",
              i.normalized_url as "normalizedUrl", i.state,
              i.validation_code as "validationCode",
              i.validation_summary as "validationSummary",
              i.duplicate_of_item_id as "duplicateOfItemId",
              i.ingestion_job_id as "jobId", j.state as "jobState",
              i.retry_count as "retryCount"
         from import_batch_items i
         left join ingestion_jobs j on j.id = i.ingestion_job_id
        where i.batch_id = $1::uuid
        order by i.ordinal`,
      [batchId],
    ),
  ]);
  const batch = batchResult.rows[0];
  if (!batch) return null;
  const items = itemResult.rows.map((item) => {
    const submissionState = item.state as ImportBatchItemState;
    const jobState = item.jobState ? (item.jobState as JobState) : null;
    return {
      submissionState,
      id: String(item.id),
      ordinal: Number(item.ordinal),
      kind: item.kind ? (String(item.kind) as ImportKind) : null,
      originalUrl: item.originalUrl ? String(item.originalUrl) : null,
      normalizedUrl: item.normalizedUrl ? String(item.normalizedUrl) : null,
      state: submissionState === "queued" && jobState
        ? jobState
        : submissionState,
      validationCode: item.validationCode ? String(item.validationCode) : null,
      validationSummary: item.validationSummary
        ? String(item.validationSummary)
        : null,
      duplicateOfItemId: item.duplicateOfItemId
        ? String(item.duplicateOfItemId)
        : null,
      jobId: item.jobId ? String(item.jobId) : null,
      jobState,
      retryCount: Number(item.retryCount),
    };
  });
  return {
    id: String(batch.id),
    state: deriveCurrentImportBatchState(items),
    totalItems: Number(batch.totalItems),
    queuedItems: Number(batch.queuedItems),
    duplicateItems: Number(batch.duplicateItems),
    invalidItems: Number(batch.invalidItems),
    correlationId: String(batch.correlationId),
    createdAt:
      batch.createdAt instanceof Date
        ? batch.createdAt.toISOString()
        : String(batch.createdAt),
    items: items.map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      kind: item.kind,
      originalUrl: item.originalUrl,
      normalizedUrl: item.normalizedUrl,
      state: item.state,
      validationCode: item.validationCode,
      validationSummary: item.validationSummary,
      duplicateOfItemId: item.duplicateOfItemId,
      jobId: item.jobId,
      jobState: item.jobState,
      retryCount: item.retryCount,
    })),
  };
}

async function insertBatchItem(
  client: PoolClient,
  batchId: string,
  item: ValidatedBatchItem,
  state: ImportBatchItemState,
  options: { duplicateOfItemId?: string; jobId?: string } = {},
): Promise<string> {
  const result = await client.query(
    `insert into import_batch_items
      (batch_id, ordinal, kind, original_url, normalized_url, state,
       validation_code, validation_summary, duplicate_of_item_id,
       ingestion_job_id)
     values ($1::uuid, $2, $3, $4, $5, $6::import_batch_item_state,
             $7, $8, $9::uuid, $10::uuid)
     returning id`,
    [
      batchId,
      item.ordinal,
      item.kind,
      item.originalUrl,
      item.normalizedUrl,
      state,
      item.validationCode,
      item.validationSummary,
      options.duplicateOfItemId ?? null,
      options.jobId ?? null,
    ],
  );
  return String(result.rows[0].id);
}

async function createDemoBatch(options: {
  actor: AuthenticatedActor;
  items: unknown[];
  correlationId: string;
  key: string;
}): Promise<{ batch: ImportBatchDto; created: boolean }> {
  const existingId = demoBatchKeys.get(options.key);
  if (existingId) return { batch: demoBatches.get(existingId)!, created: false };
  const id = randomUUID();
  const validated = validateImportBatchItems(options.items);
  const rows: ImportBatchItemDto[] = [];
  const itemIdByOrdinal = new Map<number, string>();
  for (const item of validated) {
    const itemId = randomUUID();
    itemIdByOrdinal.set(item.ordinal, itemId);
    if (!item.input) {
      rows.push({
        id: itemId, ordinal: item.ordinal, kind: null,
        originalUrl: item.originalUrl, normalizedUrl: null, state: "invalid",
        validationCode: item.validationCode,
        validationSummary: item.validationSummary,
        duplicateOfItemId: null, jobId: null, jobState: null, retryCount: 0,
      });
      continue;
    }
    if (item.duplicateOfOrdinal !== null) {
      rows.push({
        id: itemId, ordinal: item.ordinal, kind: item.input.kind,
        originalUrl: item.originalUrl, normalizedUrl: item.normalizedUrl,
        state: "duplicate", validationCode: null, validationSummary: null,
        duplicateOfItemId: itemIdByOrdinal.get(item.duplicateOfOrdinal) ?? null,
        jobId: null, jobState: null, retryCount: 0,
      });
      continue;
    }
    const queued = await queueImport({
      actor: options.actor,
      input: item.input,
      correlationId: options.correlationId,
      suppliedIdempotencyKey: `${id}:item:${item.ordinal}`,
    });
    rows.push({
      id: itemId, ordinal: item.ordinal, kind: item.input.kind,
      originalUrl: item.originalUrl, normalizedUrl: item.normalizedUrl,
      state: queued.created ? "queued" : "duplicate",
      validationCode: null, validationSummary: null,
      duplicateOfItemId: null, jobId: queued.job.id,
      jobState: queued.job.state, retryCount: 0,
    });
  }
  const queuedItems = rows.filter((item) => item.state === "queued").length;
  const duplicateItems = rows.filter((item) => item.state === "duplicate").length;
  const invalidItems = rows.filter((item) => item.state === "invalid").length;
  const batch: ImportBatchDto = {
    id,
    state: deriveImportBatchState(queuedItems, duplicateItems, invalidItems),
    totalItems: rows.length,
    queuedItems,
    duplicateItems,
    invalidItems,
    correlationId: options.correlationId,
    createdAt: new Date().toISOString(),
    items: rows,
  };
  demoBatches.set(id, batch);
  demoBatchKeys.set(options.key, id);
  return { batch, created: true };
}

export async function createImportBatch(options: {
  actor: AuthenticatedActor;
  input: z.infer<typeof importBatchRequestSchema>;
  correlationId: string;
  suppliedIdempotencyKey?: string | null;
}): Promise<{ batch: ImportBatchDto; created: boolean }> {
  const key = batchKey({
    actorId: options.actor.userId,
    items: options.input.items,
    suppliedKey: options.suppliedIdempotencyKey,
  });
  if (getServerConfig().mode === "demo") {
    return createDemoBatch({
      actor: options.actor,
      items: options.input.items,
      correlationId: options.correlationId,
      key,
    });
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const inserted = await client.query(
      `insert into import_batches
        (idempotency_key, requested_by_user_id, correlation_id, total_items)
       values ($1, $2::uuid, $3::uuid, $4)
       on conflict (idempotency_key) do nothing
       returning id`,
      [key, options.actor.userId, options.correlationId, options.input.items.length],
    );
    if (!inserted.rows[0]) {
      const existing = await client.query(
        "select id from import_batches where idempotency_key = $1",
        [key],
      );
      const batch = await readBatch(client, String(existing.rows[0].id));
      await client.query("commit");
      if (!batch) throw new Error("The idempotent import batch could not be read.");
      return { batch, created: false };
    }

    const batchId = String(inserted.rows[0].id);
    const validated = validateImportBatchItems(options.input.items);
    const itemIdByOrdinal = new Map<number, string>();
    let queuedItems = 0;
    let duplicateItems = 0;
    let invalidItems = 0;
    for (const item of validated) {
      if (!item.input) {
        const id = await insertBatchItem(client, batchId, item, "invalid");
        itemIdByOrdinal.set(item.ordinal, id);
        invalidItems += 1;
        continue;
      }
      if (item.duplicateOfOrdinal !== null) {
        const id = await insertBatchItem(client, batchId, item, "duplicate", {
          duplicateOfItemId: itemIdByOrdinal.get(item.duplicateOfOrdinal),
        });
        itemIdByOrdinal.set(item.ordinal, id);
        duplicateItems += 1;
        continue;
      }
      const queued = await queueImportWithClient(client, {
        actor: options.actor,
        input: item.input,
        correlationId: options.correlationId,
        suppliedIdempotencyKey: `${batchId}:item:${item.ordinal}`,
      });
      const itemState = queued.created ? "queued" : "duplicate";
      const id = await insertBatchItem(client, batchId, item, itemState, {
        jobId: queued.job.id,
      });
      itemIdByOrdinal.set(item.ordinal, id);
      if (queued.created) queuedItems += 1;
      else duplicateItems += 1;
    }
    const state = deriveImportBatchState(
      queuedItems,
      duplicateItems,
      invalidItems,
    );
    await client.query(
      `update import_batches
          set state = $2::import_batch_state, queued_items = $3,
              duplicate_items = $4, invalid_items = $5, updated_at = now()
        where id = $1::uuid`,
      [batchId, state, queuedItems, duplicateItems, invalidItems],
    );
    await client.query(
      `insert into audit_events
        (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
       values ($1::uuid, 'import_batch.queued', 'import_batch', $2,
               $3::uuid, $4::jsonb)`,
      [
        options.actor.userId,
        batchId,
        options.correlationId,
        JSON.stringify({ queuedItems, duplicateItems, invalidItems }),
      ],
    );
    const batch = await readBatch(client, batchId);
    await client.query("commit");
    if (!batch) throw new Error("The created import batch could not be read.");
    return { batch, created: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getImportBatch(options: {
  actor: AuthenticatedActor;
  batchId: string;
}): Promise<ImportBatchDto> {
  if (getServerConfig().mode === "demo") {
    const batch = demoBatches.get(options.batchId);
    if (!batch) throw notFound("The import batch does not exist.");
    return batch;
  }
  const ownership = await getPool().query(
    `select id from import_batches
      where id = $1::uuid and requested_by_user_id = $2::uuid`,
    [options.batchId, options.actor.userId],
  );
  if (!ownership.rows[0]) throw notFound("The import batch does not exist.");
  const batch = await readBatch(getPool(), options.batchId);
  if (!batch) throw notFound("The import batch does not exist.");
  return batch;
}

export async function retryImportBatchItem(options: {
  actor: AuthenticatedActor;
  batchId: string;
  itemId: string;
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const batch = demoBatches.get(options.batchId);
    const item = batch?.items.find((candidate) => candidate.id === options.itemId);
    if (!item) throw notFound("The import batch item does not exist.");
    if (item.state !== "queued" || !item.jobId) throw conflict("batch_item_not_retryable", "Only a queued item with a failed job can be retried.");
    const retried = await retryJob({ actor: options.actor, jobId: item.jobId, correlationId: options.correlationId });
    item.retryCount += retried.created ? 1 : 0;
    item.jobState = retried.state;
    return { itemId: item.id, jobId: item.jobId, state: retried.state, created: retried.created };
  }

  const selected = await getPool().query(
    `select i.id, i.state, i.ingestion_job_id as "jobId"
       from import_batch_items i
       join import_batches b on b.id = i.batch_id
      where i.id = $1::uuid and i.batch_id = $2::uuid
        and b.requested_by_user_id = $3::uuid`,
    [options.itemId, options.batchId, options.actor.userId],
  );
  const item = selected.rows[0];
  if (!item) throw notFound("The import batch item does not exist.");
  if (item.state !== "queued" || !item.jobId) {
    throw conflict(
      "batch_item_not_retryable",
      "Only a queued item with a failed job can be retried.",
    );
  }
  const retried = await retryJob({
    actor: options.actor,
    jobId: String(item.jobId),
    correlationId: options.correlationId,
  });
  if (retried.created) {
    await getPool().query(
      `update import_batch_items
          set retry_count = retry_count + 1, updated_at = now()
        where id = $1::uuid`,
      [options.itemId],
    );
  }
  return {
    itemId: options.itemId,
    jobId: String(item.jobId),
    state: retried.state,
    created: retried.created,
  };
}
