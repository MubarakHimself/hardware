import "server-only";
import { getPool } from "../../db/index";
import {
  emptyDatabaseMetricsSnapshot,
  renderPrometheusMetrics,
  type DatabaseMetricsSnapshot,
} from "../observability/metrics";
import { getServerConfig, ServerConfigurationError } from "./config";
import { ApiError } from "./errors";
import { isAuthorizedProbeRequest } from "./probe-auth";

interface MetricsQueryClient {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function requireMetricsAuthorization(
  request: Request,
  expectedSecret: string,
): void {
  if (expectedSecret.length < 32) {
    throw new ServerConfigurationError(
      "The operational probe token must contain at least 32 characters.",
    );
  }
  if (!isAuthorizedProbeRequest(request, expectedSecret)) {
    throw new ApiError({
      status: 401,
      code: "metrics_authentication_required",
      title: "Authentication required",
      detail: "A valid operational probe token is required.",
      headers: { "www-authenticate": "Bearer" },
    });
  }
}

export async function collectDatabaseMetrics(
  client: MetricsQueryClient = getPool(),
): Promise<DatabaseMetricsSnapshot> {
  const [queue, durations, failures, providerErrors, heartbeat, channels] =
    await Promise.all([
      client.query(`
        select type::text, state::text, count(*)::bigint as count
          from ingestion_jobs
         where state in ('queued', 'running')
         group by type, state
         order by type, state
      `),
      client.query(`
        select type::text, state::text,
               count(*)::bigint as count,
               coalesce(sum(extract(epoch from (finished_at - started_at))), 0)::double precision as sum_seconds,
               percentile_cont(0.95) within group (
                 order by extract(epoch from (finished_at - started_at))
               )::double precision as p95_seconds
          from ingestion_jobs
         where state in ('succeeded', 'failed')
           and started_at is not null
           and finished_at is not null
           and finished_at >= started_at
         group by type, state
         order by type, state
      `),
      client.query(`
        select j.type::text, e.code, count(*)::bigint as count
          from ingestion_events e
          join ingestion_jobs j on j.id = e.job_id
         where e.level in ('warning', 'error')
         group by j.type, e.code
         order by j.type, e.code
      `),
      client.query(`
        select case
                 when e.code in ('YOUTUBE_RATE_LIMITED', 'GITHUB_RATE_LIMITED') then 'quota'
                 else 'fetch'
               end as category,
               e.code,
               count(*)::bigint as count
          from ingestion_events e
         where e.code in ('YOUTUBE_RATE_LIMITED', 'GITHUB_RATE_LIMITED')
            or e.code like 'WEBSITE\\_%' escape '\\'
         group by category, e.code
         order by category, e.code
      `),
      client.query(`
        select (count(*) filter (
                 where last_seen_at >= now() - interval '60 seconds'
               ))::int as active_workers,
               extract(epoch from (now() - max(last_seen_at)))::double precision as heartbeat_age_seconds
          from worker_heartbeats
      `),
      client.query(`
        select id::text as channel_id,
               extract(epoch from (now() - last_synced_at))::double precision as sync_age_seconds,
               extract(epoch from last_synced_at)::double precision as last_success_unix_seconds
          from channel_sources
         where enabled = true
         order by id
      `),
    ]);

  const heartbeatRow = heartbeat.rows[0] ?? {};
  return {
    queueDepth: queue.rows.map((row) => ({
      type: String(row.type),
      state: String(row.state) as "queued" | "running",
      count: safeNumber(row.count),
    })),
    jobDurations: durations.rows.map((row) => ({
      type: String(row.type),
      state: String(row.state) as "failed" | "succeeded",
      count: safeNumber(row.count),
      sumSeconds: safeNumber(row.sum_seconds),
      p95Seconds: nullableNumber(row.p95_seconds),
    })),
    jobFailures: failures.rows.map((row) => ({
      type: String(row.type),
      code: String(row.code),
      count: safeNumber(row.count),
    })),
    providerErrors: providerErrors.rows.map((row) => ({
      category: String(row.category) as "fetch" | "quota",
      code: String(row.code),
      count: safeNumber(row.count),
    })),
    activeWorkerHeartbeats: safeNumber(heartbeatRow.active_workers),
    workerHeartbeatAgeSeconds: nullableNumber(
      heartbeatRow.heartbeat_age_seconds,
    ),
    channels: channels.rows.map((row) => ({
      channelId: String(row.channel_id),
      syncAgeSeconds: nullableNumber(row.sync_age_seconds),
      lastSuccessUnixSeconds: nullableNumber(row.last_success_unix_seconds),
    })),
  };
}

function metricsSecret(): string {
  const config = getServerConfig();
  if (config.mode === "local") return config.healthcheckToken;
  const localSecret = process.env.HEALTHCHECK_TOKEN?.trim();
  if (!localSecret || localSecret.length < 32) {
    throw new ServerConfigurationError(
      "HEALTHCHECK_TOKEN is required to enable metrics in demo mode.",
    );
  }
  return localSecret;
}

export async function protectedMetrics(request: Request): Promise<string> {
  const secret = metricsSecret();
  requireMetricsAuthorization(request, secret);
  const config = getServerConfig();
  const database =
    config.mode === "local"
      ? await collectDatabaseMetrics()
      : emptyDatabaseMetricsSnapshot();
  return renderPrometheusMetrics(database);
}
