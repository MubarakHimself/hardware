import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPool } from "../../db/index";
import type { AuthenticatedActor } from "../domain";
import {
  IntegrationError,
  parseYouTubeChannelReference,
  YouTubeClient,
} from "../integrations";
import { getServerConfig } from "./config";
import { getDemoState } from "./demo-store";
import { ApiError, notFound } from "./errors";
import { addTrackedGraphileJob } from "./job-queue";

export const channelCreateSchema = z
  .object({
    url: z.string().trim().min(2).max(500),
  })
  .strict();

export interface ChannelDto {
  id: string;
  title: string;
  handle: string | null;
  canonicalUrl: string | null;
  thumbnailUrl: string | null;
  status: "healthy" | "syncing" | "attention";
  videoCount: number;
  projectCount: number;
  progress: number | null;
  progressLabel: string | null;
  warningCount: number;
  failureCount: number;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  retryableJobId: string | null;
}

function dateText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function demoChannelDto(
  channel: ReturnType<typeof getDemoState>["channels"][number],
): ChannelDto {
  return {
    id: channel.id,
    title: channel.name,
    handle: channel.handle,
    canonicalUrl: `https://www.youtube.com/${channel.handle}`,
    thumbnailUrl: null,
    status: channel.status,
    videoCount: channel.videos,
    projectCount: channel.projects,
    progress: channel.progress ?? null,
    progressLabel: channel.progressLabel ?? null,
    warningCount: channel.status === "attention" ? 1 : 0,
    failureCount: channel.status === "attention" ? 1 : 0,
    lastSyncedAt: channel.lastSync,
    nextSyncAt: channel.nextSync,
    retryableJobId:
      channel.status === "attention" ? `failed-${channel.id}` : null,
  };
}

function lookupFromInput(value: string): { id?: string; handle?: string } {
  try {
    const reference = parseYouTubeChannelReference(value);
    return reference.kind === "id"
      ? { id: reference.value }
      : { handle: reference.value };
  } catch (error) {
    if (error instanceof IntegrationError) {
      throw new ApiError({ status: 422, code: error.code.toLowerCase(), title: "Validation failed", detail: error.message });
    }
    throw error;
  }
}

async function resolveYouTubeChannel(value: string) {
  const config = getServerConfig();
  if (config.mode !== "production") throw new Error("Production channel resolution called in demo mode.");
  try {
    const channel = await new YouTubeClient({
      apiKey: config.youtubeApiKey,
      timeoutMs: 10_000,
    }).resolveChannel(value);
    return {
      youtubeChannelId: channel.id,
      uploadsPlaylistId: channel.uploadsPlaylistId,
      title: channel.title,
      handle: channel.handle ?? null,
      canonicalUrl: channel.canonicalUrl,
      thumbnailUrl: channel.thumbnailUrl ?? null,
    };
  } catch (error) {
    if (error instanceof IntegrationError) {
      const status = error.code.includes("NOT_FOUND")
        ? 404
        : error.code.includes("RATE_LIMITED")
          ? 429
          : error.retryable
            ? 503
            : 422;
      throw new ApiError({
        status,
        code: error.code.toLowerCase(),
        title: status === 404 ? "Not found" : status === 422 ? "Validation failed" : "Upstream unavailable",
        detail: error.message,
        headers: error.retryAfterMs ? { "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))) } : undefined,
      });
    }
    throw error;
  }
}

export async function listChannels(): Promise<ChannelDto[]> {
  if (getServerConfig().mode === "demo") {
    return getDemoState().channels.map(demoChannelDto);
  }
  const result = await getPool().query(
    `select c.id, c.youtube_channel_id as "youtubeChannelId", c.title, c.handle,
      c.canonical_url as "canonicalUrl", c.thumbnail_url as "thumbnailUrl",
      case
        when latest.state in ('queued', 'running') or children.active_count > 0
          then 'syncing'
        when c.state = 'error' or latest.state = 'failed'
          or children.failed_count > 0 then 'attention'
        else 'healthy'
      end as status,
      c.last_synced_at as "lastSyncedAt", c.next_sync_at as "nextSyncAt",
      count(distinct v.id)::int as "videoCount",
      count(distinct p.id)::int as "projectCount",
      latest.id as "latestJobId", latest.state as "latestJobState",
      case when children.total_count > 0 then children.total_count
           else coalesce(latest.total_items, 0) end::int as "totalItems",
      case when children.total_count > 0 then children.completed_count
           else coalesce(latest.completed_items, 0) end::int as "completedItems",
      (coalesce(latest.warning_count, 0)
        + case when latest.state <> 'failed' then coalesce(latest.failure_count, 0) else 0 end
        + coalesce(children.warning_count, 0))::int as "warningCount",
      ((case when latest.state = 'failed' then 1 else 0 end)
        + coalesce(children.failed_count, 0))::int as "failureCount",
      case
        when (case when children.total_count > 0 then children.total_count
                   else coalesce(latest.total_items, 0) end) > 0
        then round(
          100.0 *
          (case when children.total_count > 0 then children.completed_count
                else coalesce(latest.completed_items, 0) end) /
          (case when children.total_count > 0 then children.total_count
                else latest.total_items end)
        )::int
        else null
      end as progress,
      case when latest.state = 'failed' then latest.id
           else child_failure.id end as "retryableJobId"
    from channel_sources c
    left join video_sources v on v.channel_id = c.id
    left join sightings s on s.channel_id = c.id
    left join projects p on p.id = s.project_id and p.state = 'active'
    left join lateral (
      select j.* from ingestion_jobs j
       where j.scope_type = 'channel' and j.scope_id = c.id::text
       order by j.created_at desc limit 1
    ) latest on true
    left join lateral (
      select count(*)::int as total_count,
             (count(*) filter (
               where child.state in ('succeeded', 'failed', 'cancelled')
             ))::int as completed_count,
             (count(*) filter (
               where child.state in ('queued', 'running')
             ))::int as active_count,
             (count(*) filter (where child.state = 'failed'))::int as failed_count,
             (
               coalesce(sum(child.warning_count), 0)
               + count(*) filter (
                   where child.state <> 'failed' and child.failure_count > 0
                 )
             )::int as warning_count
        from ingestion_jobs child
       where child.type = 'video_ingest'
         and child.checkpoint ->> 'parentJobId' = latest.id::text
    ) children on true
    left join lateral (
      select child.id
        from ingestion_jobs child
       where child.type = 'video_ingest'
         and child.checkpoint ->> 'parentJobId' = latest.id::text
         and child.state = 'failed'
       order by child.finished_at desc nulls last, child.created_at desc
       limit 1
    ) child_failure on true
    group by c.id, latest.id, latest.state, latest.total_items, latest.completed_items,
             latest.warning_count, latest.failure_count,
             children.total_count, children.completed_count,
             children.active_count, children.failed_count,
             children.warning_count, child_failure.id
    order by c.title, c.id`,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    handle: row.handle ? String(row.handle) : null,
    canonicalUrl: row.canonicalUrl ? String(row.canonicalUrl) : null,
    thumbnailUrl: row.thumbnailUrl ? String(row.thumbnailUrl) : null,
    status: row.status as ChannelDto["status"],
    videoCount: Number(row.videoCount ?? 0),
    projectCount: Number(row.projectCount ?? 0),
    progress: row.progress === null ? null : Number(row.progress),
    progressLabel:
      row.totalItems > 0
        ? `${Number(row.completedItems)} of ${Number(row.totalItems)} items`
        : null,
    warningCount: Number(row.warningCount ?? 0),
    failureCount: Number(row.failureCount ?? 0),
    lastSyncedAt: dateText(row.lastSyncedAt),
    nextSyncAt: dateText(row.nextSyncAt),
    retryableJobId: row.retryableJobId
      ? String(row.retryableJobId)
      : null,
  }));
}

export async function addChannel(options: {
  actor: AuthenticatedActor;
  input: z.infer<typeof channelCreateSchema>;
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const lookup = lookupFromInput(options.input.url);
    const handle = lookup.handle ? `@${lookup.handle}` : `@channel-${state.channels.length + 1}`;
    const existing = state.channels.find((channel) => channel.handle.toLowerCase() === handle.toLowerCase());
    if (existing) {
      return { channel: demoChannelDto(existing), created: false, jobId: null };
    }
    const channel = {
      id: randomUUID(),
      name: lookup.handle ?? "Imported channel",
      handle,
      avatar: (lookup.handle ?? "IC").slice(0, 2).toUpperCase(),
      status: "syncing" as const,
      videos: 0,
      projects: 0,
      progress: 0,
      progressLabel: "Backfill queued",
      lastSync: "not yet synced",
      nextSync: "after backfill",
    };
    state.channels.push(channel);
    return {
      channel: demoChannelDto(channel),
      created: true,
      jobId: `backfill-${channel.id}`,
    };
  }

  const channel = await resolveYouTubeChannel(options.input.url);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const inserted = await client.query(
      `insert into channel_sources
        (youtube_channel_id, uploads_playlist_id, handle, title, canonical_url,
         thumbnail_url, created_by_user_id, next_sync_at)
       values ($1, $2, $3, $4, $5, $6, $7::uuid, now())
       on conflict (youtube_channel_id) do nothing
       returning id, youtube_channel_id as "youtubeChannelId", title, handle,
                 canonical_url as "canonicalUrl", thumbnail_url as "thumbnailUrl",
                 last_synced_at as "lastSyncedAt", next_sync_at as "nextSyncAt"`,
      [channel.youtubeChannelId, channel.uploadsPlaylistId, channel.handle, channel.title, channel.canonicalUrl, channel.thumbnailUrl, options.actor.userId],
    );
    const created = Boolean(inserted.rows[0]);
    const record =
      inserted.rows[0] ??
      (
        await client.query(
          `update channel_sources set uploads_playlist_id = $2, handle = $3,
             title = $4, canonical_url = $5, thumbnail_url = $6, updated_at = now()
           where youtube_channel_id = $1
           returning id, youtube_channel_id as "youtubeChannelId", title, handle,
                     canonical_url as "canonicalUrl", thumbnail_url as "thumbnailUrl",
                     last_synced_at as "lastSyncedAt", next_sync_at as "nextSyncAt"`,
          [channel.youtubeChannelId, channel.uploadsPlaylistId, channel.handle, channel.title, channel.canonicalUrl, channel.thumbnailUrl],
        )
      ).rows[0];
    let jobId: string | null = null;
    if (created) {
      const job = await client.query(
        `insert into ingestion_jobs
          (type, idempotency_key, scope_type, scope_id, requested_by_user_id,
           correlation_id, checkpoint)
         values ('channel_backfill', $1, 'channel', $2, $3::uuid, $4::uuid,
                 $5::jsonb)
         returning id`,
        [
          `channel:${record.id}:backfill`,
          record.id,
          options.actor.userId,
          options.correlationId,
          JSON.stringify({ channelSourceId: record.id }),
        ],
      );
      const createdJobId = String(job.rows[0].id);
      jobId = createdJobId;
      const graphileId = await addTrackedGraphileJob(client, {
        task: "channel_backfill",
        jobId: createdJobId,
        correlationId: options.correlationId,
        jobKey: `hardware:channel:${record.id}:backfill`,
        payload: { channelSourceId: record.id },
      });
      await client.query("update ingestion_jobs set graphile_job_id = $1 where id = $2::uuid", [graphileId, createdJobId]);
      await client.query(
        `insert into audit_events
          (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
         values ($1::uuid, 'channel.added', 'channel', $2, $3::uuid, $4::jsonb)`,
        [options.actor.userId, record.id, options.correlationId, JSON.stringify({ youtubeChannelId: record.youtubeChannelId })],
      );
    }
    await client.query("commit");
    const responseChannel: ChannelDto = {
      id: String(record.id),
      title: String(record.title),
      handle: record.handle ? String(record.handle) : null,
      canonicalUrl: record.canonicalUrl ? String(record.canonicalUrl) : null,
      thumbnailUrl: record.thumbnailUrl ? String(record.thumbnailUrl) : null,
      status: created ? "syncing" : "healthy",
      videoCount: 0,
      projectCount: 0,
      progress: created ? 0 : null,
      progressLabel: created ? "Backfill queued" : null,
      warningCount: 0,
      failureCount: 0,
      lastSyncedAt: dateText(record.lastSyncedAt),
      nextSyncAt: dateText(record.nextSyncAt),
      retryableJobId: null,
    };
    return { channel: responseChannel, created, jobId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function syncChannel(options: {
  actor: AuthenticatedActor;
  channelId: string;
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const channel = getDemoState().channels.find((item) => item.id === options.channelId);
    if (!channel) throw notFound("The channel does not exist.");
    channel.status = "syncing";
    channel.progress = 0;
    channel.progressLabel = "Sync queued";
    return { channelId: channel.id, jobId: `poll-${randomUUID()}`, created: true };
  }
  z.string().uuid().parse(options.channelId);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const channel = await client.query("select id from channel_sources where id = $1::uuid and enabled = true for update", [options.channelId]);
    if (!channel.rows[0]) throw notFound("The channel does not exist or is disabled.");
    const bucket = new Date().toISOString().slice(0, 13);
    const key = `channel:${options.channelId}:poll:${bucket}`;
    const job = await client.query(
      `insert into ingestion_jobs
        (type, idempotency_key, scope_type, scope_id, requested_by_user_id,
         correlation_id, checkpoint)
       values ('channel_poll', $1, 'channel', $2, $3::uuid, $4::uuid,
               $5::jsonb)
       on conflict (idempotency_key) do nothing returning id`,
      [
        key,
        options.channelId,
        options.actor.userId,
        options.correlationId,
        JSON.stringify({ channelSourceId: options.channelId }),
      ],
    );
    let jobId: string;
    let created = true;
    if (!job.rows[0]) {
      const existing = await client.query("select id from ingestion_jobs where idempotency_key = $1", [key]);
      jobId = existing.rows[0].id;
      created = false;
    } else {
      jobId = job.rows[0].id;
      const graphileId = await addTrackedGraphileJob(client, { task: "channel_poll", jobId, correlationId: options.correlationId, jobKey: `hardware:${key}`, payload: { channelSourceId: options.channelId } });
      await client.query("update ingestion_jobs set graphile_job_id = $1 where id = $2::uuid", [graphileId, jobId]);
      await client.query(
        `insert into audit_events
          (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
         values ($1::uuid, 'channel.sync_queued', 'channel', $2, $3::uuid, $4::jsonb)`,
        [options.actor.userId, options.channelId, options.correlationId, JSON.stringify({ jobId })],
      );
    }
    await client.query("commit");
    return { channelId: options.channelId, jobId, created };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
