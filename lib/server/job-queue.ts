import "server-only";
import type { PoolClient } from "pg";
import type { IngestionJobType } from "../domain";
import { requireTaskProviderConfigured } from "./providers";

export async function addTrackedGraphileJob(
  client: PoolClient,
  options: {
    task: IngestionJobType;
    jobId: string;
    correlationId: string;
    jobKey: string;
    queueName?: string;
    payload?: Record<string, unknown>;
  },
): Promise<number | null> {
  requireTaskProviderConfigured(options.task);
  const result = await client.query<{ id: number }>(
    `select (graphile_worker.add_job(
      $1::text,
      payload := $2::json,
      max_attempts := 3,
      job_key := $3::text,
      job_key_mode := 'unsafe_dedupe',
      queue_name := $4::text
    )).id as id`,
    [
      options.task,
      JSON.stringify({
        jobId: options.jobId,
        correlationId: options.correlationId,
        ...options.payload,
      }),
      options.jobKey,
      options.queueName ?? null,
    ],
  );
  return result.rows[0]?.id ?? null;
}
