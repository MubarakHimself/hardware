import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPool } from "../../db/index";
import {
  CHANNEL_SYNC_FREQUENCIES,
  type AuthenticatedActor,
  type ChannelHistoryMode,
  type ChannelSyncFrequency,
} from "../domain";
import {
  IntegrationError,
  parseYouTubeChannelReference,
  YouTubeClient,
} from "../integrations";
import { getServerConfig } from "./config";
import { getDemoState } from "./demo-store";
import { ApiError, notFound } from "./errors";
import { addTrackedGraphileJob } from "./job-queue";
import { findActiveChannelJob, lockChannelJobLane } from "./channel-jobs";

const initialHistorySchema = z.union([
  z.object({ mode: z.enum(["latest_10", "latest_25", "latest_50", "all"]) }).strict(),
  z.object({ mode: z.literal("since"), since: z.iso.datetime({ offset: true }) }).strict(),
  z.object({
    mode: z.literal("since"),
    since: z.iso.date(),
    // Minutes east of UTC, matching Date#getTimezoneOffset with its sign
    // inverted. Requiring it avoids interpreting a personal date as UTC.
    utcOffsetMinutes: z.number().int().min(-840).max(840),
  }).strict(),
]);

export function historySinceInstant(
  history: z.infer<typeof initialHistorySchema>,
): Date | null {
  if (history.mode !== "since") return null;
  if (history.since.includes("T")) return new Date(history.since);
  const [year, month, day] = history.since.split("-").map(Number);
  const utcOffsetMinutes = "utcOffsetMinutes" in history
    ? history.utcOffsetMinutes
    : 0;
  return new Date(
    Date.UTC(year, month - 1, day) - utcOffsetMinutes * 60_000,
  );
}

export const channelCreateSchema = z
  .object({
    url: z.string().trim().min(2).max(500),
    syncFrequency: z.enum(CHANNEL_SYNC_FREQUENCIES).default("daily"),
    initialHistory: initialHistorySchema.default({ mode: "latest_25" }),
  })
  .strict();

export const channelUpdateSchema = z
  .object({
    syncFrequency: z.enum(CHANNEL_SYNC_FREQUENCIES).optional(),
    paused: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.syncFrequency !== undefined || value.paused !== undefined, {
    message: "Provide a sync frequency or paused state.",
  });

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
  monitored: boolean;
  paused: boolean;
  syncFrequency: ChannelSyncFrequency;
  initialHistoryMode: ChannelHistoryMode;
  initialHistorySince: string | null;
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
    monitored: true,
    paused: false,
    syncFrequency: "daily",
    initialHistoryMode: "latest_25",
    initialHistorySince: null,
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
  if (config.mode !== "local") throw new Error("Persistent channel resolution called in demo mode.");
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
      c.enabled as monitored, c.state = 'paused' as paused,
      c.sync_frequency as "syncFrequency",
      c.initial_history_mode as "initialHistoryMode",
      c.initial_history_since as "initialHistorySince",
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
    where c.enabled = true
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
    monitored: Boolean(row.monitored),
    paused: Boolean(row.paused),
    syncFrequency: row.syncFrequency as ChannelSyncFrequency,
    initialHistoryMode: row.initialHistoryMode as ChannelHistoryMode,
    initialHistorySince: dateText(row.initialHistorySince),
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
      return { channel: demoChannelDto(existing), created: false, monitoringStarted: false, jobId: null };
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
      monitoringStarted: true,
      jobId: `backfill-${channel.id}`,
    };
  }

  const channel = await resolveYouTubeChannel(options.input.url);
  const historyMode = options.input.initialHistory.mode;
  const historySince = historySinceInstant(options.input.initialHistory);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const existing = await client.query(
      `select id, enabled, state, sync_frequency as "syncFrequency",
              initial_history_mode as "initialHistoryMode",
              initial_history_since as "initialHistorySince",
              last_synced_at as "lastSyncedAt",
              next_sync_at as "nextSyncAt"
         from channel_sources
        where youtube_channel_id = $1 for update`,
      [channel.youtubeChannelId],
    );
    const created = !existing.rows[0];
    const monitoringStarted = created || !Boolean(existing.rows[0]?.enabled);
    const record = created
      ? (
          await client.query(
            `insert into channel_sources
              (youtube_channel_id, uploads_playlist_id, handle, title,
               canonical_url, thumbnail_url, created_by_user_id, enabled,
               state, sync_frequency, initial_history_mode,
               initial_history_since, next_sync_at)
             values ($1, $2, $3, $4, $5, $6, $7::uuid, true, 'active',
                     $8, $9, $10, null)
             returning id, youtube_channel_id as "youtubeChannelId", title,
                       handle, canonical_url as "canonicalUrl",
                       thumbnail_url as "thumbnailUrl",
                       state, sync_frequency as "syncFrequency",
                       initial_history_mode as "initialHistoryMode",
                       initial_history_since as "initialHistorySince",
                       last_synced_at as "lastSyncedAt",
                       next_sync_at as "nextSyncAt"`,
            [
              channel.youtubeChannelId,
              channel.uploadsPlaylistId,
              channel.handle,
              channel.title,
              channel.canonicalUrl,
              channel.thumbnailUrl,
              options.actor.userId,
              options.input.syncFrequency,
              historyMode,
              historySince,
            ],
          )
        ).rows[0]
      : monitoringStarted
        ? (
          await client.query(
            `update channel_sources
                set uploads_playlist_id = $2, handle = $3, title = $4,
                    canonical_url = $5, thumbnail_url = $6, enabled = true,
                    state = 'active', sync_frequency = $7,
                    initial_history_mode = $8, initial_history_since = $9,
                    next_sync_at = null,
                    last_error_code = null, last_error_summary = null,
                    updated_at = now()
              where youtube_channel_id = $1
              returning id, youtube_channel_id as "youtubeChannelId", title,
                        handle, canonical_url as "canonicalUrl",
                        thumbnail_url as "thumbnailUrl",
                        state, sync_frequency as "syncFrequency",
                        initial_history_mode as "initialHistoryMode",
                        initial_history_since as "initialHistorySince",
                        last_synced_at as "lastSyncedAt",
                        next_sync_at as "nextSyncAt"`,
            [
              channel.youtubeChannelId,
              channel.uploadsPlaylistId,
              channel.handle,
              channel.title,
              channel.canonicalUrl,
              channel.thumbnailUrl,
              options.input.syncFrequency,
              historyMode,
              historySince,
            ],
          )
        ).rows[0]
        : (
          await client.query(
            `update channel_sources
                set uploads_playlist_id = $2, handle = $3, title = $4,
                    canonical_url = $5, thumbnail_url = $6, updated_at = now()
              where youtube_channel_id = $1
              returning id, youtube_channel_id as "youtubeChannelId", title,
                        handle, canonical_url as "canonicalUrl",
                        thumbnail_url as "thumbnailUrl",
                        state, sync_frequency as "syncFrequency",
                        initial_history_mode as "initialHistoryMode",
                        initial_history_since as "initialHistorySince",
                        last_synced_at as "lastSyncedAt",
                        next_sync_at as "nextSyncAt"`,
            [
              channel.youtubeChannelId,
              channel.uploadsPlaylistId,
              channel.handle,
              channel.title,
              channel.canonicalUrl,
              channel.thumbnailUrl,
            ],
          )
        ).rows[0];
    let jobId: string | null = null;
    if (monitoringStarted) {
      await lockChannelJobLane(client, String(record.id));
      const durablePayload = {
        channelSourceId: record.id,
        historyMode,
        ...(historySince ? { historySince: historySince.toISOString() } : {}),
      };
      const activeJob = await findActiveChannelJob(client, String(record.id));
      if (activeJob) {
        jobId = activeJob.id;
      } else {
        const job = await client.query(
          `insert into ingestion_jobs
            (type, idempotency_key, scope_type, scope_id, requested_by_user_id,
             correlation_id, checkpoint)
           values ('channel_backfill', $1, 'channel', $2, $3::uuid, $4::uuid,
                   $5::jsonb)
           returning id`,
          [
            `channel:${record.id}:backfill:v2`,
            record.id,
            options.actor.userId,
            options.correlationId,
            JSON.stringify(durablePayload),
          ],
        );
        const createdJobId = String(job.rows[0].id);
        jobId = createdJobId;
        const graphileId = await addTrackedGraphileJob(client, {
          task: "channel_backfill",
          jobId: createdJobId,
          correlationId: options.correlationId,
          jobKey: `hardware:channel:${record.id}:backfill:v2`,
          queueName: `channel:${record.id}`,
          payload: durablePayload,
        });
        await client.query("update ingestion_jobs set graphile_job_id = $1 where id = $2::uuid", [graphileId, createdJobId]);
      }
      await client.query(
        `insert into audit_events
          (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
         values ($1::uuid, 'channel.monitoring_started', 'channel', $2, $3::uuid, $4::jsonb)`,
        [options.actor.userId, record.id, options.correlationId, JSON.stringify({ youtubeChannelId: record.youtubeChannelId, syncFrequency: options.input.syncFrequency, historyMode, historySince: historySince?.toISOString() ?? null })],
      );
    }
    await client.query("commit");
    const responseChannel: ChannelDto = {
      id: String(record.id),
      title: String(record.title),
      handle: record.handle ? String(record.handle) : null,
      canonicalUrl: record.canonicalUrl ? String(record.canonicalUrl) : null,
      thumbnailUrl: record.thumbnailUrl ? String(record.thumbnailUrl) : null,
      status: monitoringStarted
        ? "syncing"
        : record.state === "error"
          ? "attention"
          : "healthy",
      videoCount: 0,
      projectCount: 0,
      progress: monitoringStarted ? 0 : null,
      progressLabel: monitoringStarted ? "Backfill queued" : null,
      warningCount: 0,
      failureCount: 0,
      lastSyncedAt: dateText(record.lastSyncedAt),
      nextSyncAt: dateText(record.nextSyncAt),
      retryableJobId: null,
      monitored: true,
      paused: record.state === "paused",
      syncFrequency: record.syncFrequency as ChannelSyncFrequency,
      initialHistoryMode: record.initialHistoryMode as ChannelHistoryMode,
      initialHistorySince: dateText(record.initialHistorySince),
    };
    return { channel: responseChannel, created, monitoringStarted, jobId };
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
    await lockChannelJobLane(client, options.channelId);
    const activeJob = await findActiveChannelJob(client, options.channelId);
    if (activeJob) {
      await client.query("commit");
      return {
        channelId: options.channelId,
        jobId: activeJob.id,
        created: false,
      };
    }
    const key = `channel:${options.channelId}:poll:${options.correlationId}:${randomUUID()}`;
    const job = await client.query(
      `insert into ingestion_jobs
        (type, idempotency_key, scope_type, scope_id, requested_by_user_id,
         correlation_id, checkpoint)
       values ('channel_poll', $1, 'channel', $2, $3::uuid, $4::uuid,
               $5::jsonb)
       returning id`,
      [
        key,
        options.channelId,
        options.actor.userId,
        options.correlationId,
        JSON.stringify({ channelSourceId: options.channelId }),
      ],
    );
    const jobId = String(job.rows[0].id);
    const graphileId = await addTrackedGraphileJob(client, { task: "channel_poll", jobId, correlationId: options.correlationId, jobKey: `hardware:${key}`, queueName: `channel:${options.channelId}`, payload: { channelSourceId: options.channelId } });
    await client.query("update ingestion_jobs set graphile_job_id = $1 where id = $2::uuid", [graphileId, jobId]);
    await client.query(
      `insert into audit_events
        (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
       values ($1::uuid, 'channel.sync_queued', 'channel', $2, $3::uuid, $4::jsonb)`,
      [options.actor.userId, options.channelId, options.correlationId, JSON.stringify({ jobId })],
    );
    await client.query("commit");
    return { channelId: options.channelId, jobId, created: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateChannelSettings(options: {
  actor: AuthenticatedActor;
  channelId: string;
  input: z.infer<typeof channelUpdateSchema>;
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const channel = getDemoState().channels.find((item) => item.id === options.channelId);
    if (!channel) throw notFound("The channel does not exist.");
    if (options.input.paused === true) channel.status = "healthy";
    const dueNow =
      options.input.paused !== true &&
      options.input.syncFrequency !== "manual";
    return {
      channelId: channel.id,
      paused: options.input.paused ?? false,
      syncFrequency: options.input.syncFrequency ?? "daily",
      nextSyncAt: options.input.paused || options.input.syncFrequency === "manual"
        ? null
        : new Date().toISOString(),
      jobId: dueNow ? `poll-${randomUUID()}` : null,
      created: dueNow,
    };
  }

  z.string().uuid().parse(options.channelId);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const updated = await client.query(
      `update channel_sources
          set sync_frequency = coalesce($2::channel_sync_frequency, sync_frequency),
              state = case
                when $3::boolean is true then 'paused'::source_state
                when $3::boolean is false then 'active'::source_state
                else state
              end,
              next_sync_at = case
                when $3::boolean is true then null
                when $3::boolean is null and state = 'paused' then null
                when coalesce($2::channel_sync_frequency, sync_frequency) = 'manual' then null
                when $3::boolean is false or $2::channel_sync_frequency is not null then
                  case coalesce($2::channel_sync_frequency, sync_frequency)
                    when 'weekly' then greatest(
                      coalesce(last_synced_at + interval '7 days', now()),
                      now()
                    )
                    else greatest(
                      coalesce(last_synced_at + interval '1 day', now()),
                      now()
                    )
                  end
                else next_sync_at
              end,
              updated_at = now()
        where id = $1::uuid and enabled = true
        returning id, state = 'paused' as paused,
                  sync_frequency as "syncFrequency",
                  next_sync_at as "nextSyncAt",
                  next_sync_at is not null and next_sync_at <= now() as "dueNow"`,
      [
        options.channelId,
        options.input.syncFrequency ?? null,
        options.input.paused ?? null,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw notFound("The monitored channel does not exist.");
    let jobId: string | null = null;
    let created = false;
    if (!row.paused && row.syncFrequency !== "manual" && row.dueNow) {
      await lockChannelJobLane(client, options.channelId);
      const activeJob = await findActiveChannelJob(client, options.channelId);
      if (activeJob) {
        jobId = activeJob.id;
      } else {
        const key = `channel:${options.channelId}:settings-due:${options.correlationId}:${randomUUID()}`;
        const inserted = await client.query(
          `insert into ingestion_jobs
            (type, idempotency_key, scope_type, scope_id,
             requested_by_user_id, correlation_id, checkpoint)
           values ('channel_poll', $1, 'channel', $2, $3::uuid, $4::uuid,
                   $5::jsonb)
           returning id`,
          [
            key,
            options.channelId,
            options.actor.userId,
            options.correlationId,
            JSON.stringify({ channelSourceId: options.channelId }),
          ],
        );
        jobId = String(inserted.rows[0].id);
        const graphileId = await addTrackedGraphileJob(client, {
          task: "channel_poll",
          jobId,
          correlationId: options.correlationId,
          jobKey: `hardware:${key}`,
          queueName: `channel:${options.channelId}`,
          payload: { channelSourceId: options.channelId },
        });
        await client.query(
          "update ingestion_jobs set graphile_job_id = $1 where id = $2::uuid",
          [graphileId, jobId],
        );
        created = true;
      }
    }
    await client.query(
      `insert into audit_events
        (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
       values ($1::uuid, 'channel.settings_updated', 'channel', $2, $3::uuid, $4::jsonb)`,
      [
        options.actor.userId,
        options.channelId,
        options.correlationId,
        JSON.stringify({
          paused: Boolean(row.paused),
          syncFrequency: row.syncFrequency,
          nextSyncAt: dateText(row.nextSyncAt),
          jobId,
          created,
        }),
      ],
    );
    await client.query("commit");
    return {
      channelId: String(row.id),
      paused: Boolean(row.paused),
      syncFrequency: row.syncFrequency as ChannelSyncFrequency,
      nextSyncAt: dateText(row.nextSyncAt),
      jobId,
      created,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
