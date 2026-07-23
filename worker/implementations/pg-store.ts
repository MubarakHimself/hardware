import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ParsedLink,
  ParsedProjectMention,
  ParseDescriptionResult,
  WebsiteMetadata,
} from "../../lib/ingestion";
import type { GitHubRepositoryMetadata, YouTubeChannel, YouTubeUpload, YouTubeVideo } from "../../lib/integrations";
import type {
  CandidateInput,
  ChannelSubscriptionResult,
  IngestionStore,
  ParsedVideoTargets,
  StoredChannel,
  StoredRepository,
  StoredVideo,
} from "./contracts";

type Queryable = Pick<PoolClient, "query">;

interface ProjectIdentityRow {
  id: string;
  state: "active" | "archived" | "merged";
  merged_into_project_id: string | null;
}

interface ExistingRepositoryRow {
  id: string;
  project_id: string;
  provider_repository_id: string;
}

function slugFor(name: string, identity: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 130) || "project";
  return `${base}-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

function boundedName(name: string | undefined, url: string): string {
  const clean = name?.replace(/\s+/gu, " ").trim().slice(0, 300);
  if (clean) return clean;
  try { return new URL(url).hostname.slice(0, 300); } catch { return "Untitled project"; }
}

function repositoryParts(link: ParsedLink): { owner: string; name: string } | undefined {
  if (!link.githubRepoKey) return undefined;
  const [owner, name] = link.githubRepoKey.split("/");
  return owner && name ? { owner, name } : undefined;
}

export class PgIngestionStore implements IngestionStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const value = await work(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getChannel(id: string): Promise<StoredChannel | undefined> {
    const result = await this.pool.query<{ id: string; youtube_channel_id: string; uploads_playlist_id: string; checkpoint: Record<string, unknown> }>(
      "select id, youtube_channel_id, uploads_playlist_id, checkpoint from channel_sources where id = $1 and enabled = true",
      [id],
    );
    const row = result.rows[0];
    return row ? { id: row.id, youtubeChannelId: row.youtube_channel_id, uploadsPlaylistId: row.uploads_playlist_id, checkpoint: row.checkpoint ?? {} } : undefined;
  }

  async upsertChannel(
    channel: YouTubeChannel,
    options: { monitoringEnabled?: boolean } = {},
  ): Promise<StoredChannel> {
    const monitoringEnabled = options.monitoringEnabled ?? false;
    const result = await this.pool.query<{ id: string; youtube_channel_id: string; uploads_playlist_id: string; checkpoint: Record<string, unknown> }>(
      `insert into channel_sources (youtube_channel_id, uploads_playlist_id, handle, title, canonical_url, thumbnail_url, state, enabled)
       values ($1, $2, $3, $4, $5, $6, 'active', $7)
       on conflict (youtube_channel_id) do update set uploads_playlist_id = excluded.uploads_playlist_id, handle = excluded.handle,
         title = excluded.title, canonical_url = excluded.canonical_url, thumbnail_url = excluded.thumbnail_url,
         enabled = channel_sources.enabled or excluded.enabled,
         state = case when excluded.enabled then 'active'::source_state else channel_sources.state end,
         last_error_code = case when excluded.enabled then null else channel_sources.last_error_code end,
         last_error_summary = case when excluded.enabled then null else channel_sources.last_error_summary end,
         updated_at = now()
       returning id, youtube_channel_id, uploads_playlist_id, checkpoint`,
      [channel.id, channel.uploadsPlaylistId, channel.handle ?? null, channel.title.slice(0, 300), channel.canonicalUrl, channel.thumbnailUrl ?? null, monitoringEnabled],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Channel upsert returned no row.");
    return { id: row.id, youtubeChannelId: row.youtube_channel_id, uploadsPlaylistId: row.uploads_playlist_id, checkpoint: row.checkpoint ?? {} };
  }

  async ensureChannelSubscription(
    channel: YouTubeChannel,
    options: { subscriptionJobId: string; requestedByUserId?: string },
  ): Promise<ChannelSubscriptionResult> {
    return this.transaction(async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [`hardware:youtube-channel:${channel.id}`],
      );
      const existing = await client.query<{
        id: string;
        enabled: boolean;
      }>(
        `select id, enabled from channel_sources
          where youtube_channel_id = $1 for update`,
        [channel.id],
      );
      const marker = JSON.stringify({
        initialBackfillPending: true,
        subscriptionJobId: options.subscriptionJobId,
      });
      const row = !existing.rows[0]
        ? (
            await client.query<{
              id: string;
              youtube_channel_id: string;
              uploads_playlist_id: string;
              checkpoint: Record<string, unknown>;
            }>(
              `insert into channel_sources
                (youtube_channel_id, uploads_playlist_id, handle, title,
                 canonical_url, thumbnail_url, created_by_user_id, enabled,
                 state, sync_frequency, initial_history_mode, checkpoint,
                 next_sync_at)
               values ($1, $2, $3, $4, $5, $6,
                       (select id from users where id = $7::uuid), true,
                       'active', 'daily', 'latest_25', $8::jsonb, null)
               returning id, youtube_channel_id, uploads_playlist_id, checkpoint`,
              [
                channel.id,
                channel.uploadsPlaylistId,
                channel.handle ?? null,
                channel.title.slice(0, 300),
                channel.canonicalUrl,
                channel.thumbnailUrl ?? null,
                options.requestedByUserId ?? null,
                marker,
              ],
            )
          ).rows[0]
        : existing.rows[0].enabled
          ? (
              await client.query<{
                id: string;
                youtube_channel_id: string;
                uploads_playlist_id: string;
                checkpoint: Record<string, unknown>;
              }>(
                `update channel_sources
                    set uploads_playlist_id = $2, handle = $3, title = $4,
                        canonical_url = $5, thumbnail_url = $6,
                        updated_at = now()
                  where youtube_channel_id = $1
                  returning id, youtube_channel_id, uploads_playlist_id,
                            checkpoint`,
                [
                  channel.id,
                  channel.uploadsPlaylistId,
                  channel.handle ?? null,
                  channel.title.slice(0, 300),
                  channel.canonicalUrl,
                  channel.thumbnailUrl ?? null,
                ],
              )
            ).rows[0]
          : (
              await client.query<{
                id: string;
                youtube_channel_id: string;
                uploads_playlist_id: string;
                checkpoint: Record<string, unknown>;
              }>(
                `update channel_sources
                    set uploads_playlist_id = $2, handle = $3, title = $4,
                        canonical_url = $5, thumbnail_url = $6, enabled = true,
                        state = 'active', sync_frequency = 'daily',
                        initial_history_mode = 'latest_25',
                        initial_history_since = null, next_sync_at = null,
                        checkpoint = checkpoint || $7::jsonb,
                        created_by_user_id = coalesce(
                          created_by_user_id,
                          (select id from users where id = $8::uuid)
                        ),
                        last_error_code = null, last_error_summary = null,
                        updated_at = now()
                  where youtube_channel_id = $1
                  returning id, youtube_channel_id, uploads_playlist_id,
                            checkpoint`,
                [
                  channel.id,
                  channel.uploadsPlaylistId,
                  channel.handle ?? null,
                  channel.title.slice(0, 300),
                  channel.canonicalUrl,
                  channel.thumbnailUrl ?? null,
                  marker,
                  options.requestedByUserId ?? null,
                ],
              )
            ).rows[0];
      if (!row) throw new Error("Channel subscription upsert returned no row.");
      const checkpoint = row.checkpoint ?? {};
      const subscriptionJobId =
        checkpoint.initialBackfillPending === true &&
        typeof checkpoint.subscriptionJobId === "string"
          ? checkpoint.subscriptionJobId
          : null;
      return {
        channel: {
          id: row.id,
          youtubeChannelId: row.youtube_channel_id,
          uploadsPlaylistId: row.uploads_playlist_id,
          checkpoint,
        },
        backfillPending: subscriptionJobId !== null,
        subscriptionJobId,
      };
    });
  }

  async confirmChannelSubscriptionBackfill(
    channelId: string,
    subscriptionJobId: string,
    resolverJobId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `with child as (
         select id
           from ingestion_jobs
          where type = 'channel_backfill'
            and checkpoint ->> 'subscriptionJobId' = $2
          order by created_at
          limit 1
       ), relinked_batch_item as (
         update import_batch_items as item
            set ingestion_job_id = child.id, updated_at = now()
           from child
          where item.ingestion_job_id in ($2::uuid, $3::uuid)
          returning item.id
       ), updated_channel as (
         update channel_sources as c
            set checkpoint = c.checkpoint
                  - 'initialBackfillPending' - 'subscriptionJobId',
                updated_at = now()
          where c.id = $1::uuid
            and c.checkpoint ->> 'subscriptionJobId' = $2
            and exists (select 1 from child)
          returning c.id
       )
       select child.id,
              (select count(*) from relinked_batch_item) as relinked_item_count,
              (select count(*) from updated_channel) as cleared_channel_count
         from child`,
      [channelId, subscriptionJobId, resolverJobId],
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }

  async upsertDiscoveredVideo(channelId: string, upload: YouTubeUpload): Promise<StoredVideo> {
    const result = await this.pool.query<{ id: string; channel_id: string; youtube_video_id: string }>(
      `insert into video_sources (channel_id, youtube_video_id, title, published_at, availability)
       values ($1, $2, $3, $4, 'available')
       on conflict (youtube_video_id) do update set channel_id = excluded.channel_id,
         title = coalesce(video_sources.title, excluded.title), published_at = coalesce(video_sources.published_at, excluded.published_at), updated_at = now()
       returning id, channel_id, youtube_video_id`,
      [channelId, upload.videoId, upload.title?.slice(0, 500) ?? null, upload.publishedAt ? new Date(upload.publishedAt) : null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Video discovery upsert returned no row.");
    return { id: row.id, channelId: row.channel_id, youtubeVideoId: row.youtube_video_id };
  }

  async completeChannelSync(
    channelId: string,
    checkpoint: Record<string, unknown>,
    jobId: string,
  ): Promise<void> {
    const durableCheckpoint = { ...checkpoint };
    delete durableCheckpoint.initialBackfillPending;
    delete durableCheckpoint.subscriptionJobId;
    await this.pool.query(
      `with updated_channel as (
         update channel_sources
            set checkpoint = $2::jsonb, updated_at = now()
          where id = $1::uuid
          returning id
       )
       update ingestion_jobs j
          set checkpoint = j.checkpoint || jsonb_build_object(
                'enumerationComplete', true,
                'channelCheckpointCommittedAt', now()
              ),
              updated_at = now()
         from updated_channel
        where j.id = $3::uuid
          and j.scope_type = 'channel'
          and j.scope_id = updated_channel.id::text`,
      [channelId, JSON.stringify(durableCheckpoint), jobId],
    );
  }

  async markChannelError(channelId: string, code: string, summary: string): Promise<void> {
    await this.pool.query(
      `update channel_sources
          set state = case when state = 'paused' then 'paused'::source_state else 'error'::source_state end,
              last_error_code = $2, last_error_summary = $3,
              next_sync_at = case
                when state = 'paused' or sync_frequency = 'manual' then null
                when sync_frequency = 'weekly' then now() + interval '7 days'
                else now() + interval '1 day'
              end,
              updated_at = now()
        where id = $1`,
      [channelId, code.slice(0, 80), summary.slice(0, 500)],
    );
  }

  async getVideo(id: string): Promise<StoredVideo | undefined> {
    const result = await this.pool.query<{
      id: string;
      channel_id: string;
      youtube_video_id: string;
      youtube_channel_id: string;
      title: string | null;
      description: string | null;
      duration_seconds: number | null;
      metadata_ready: boolean;
    }>(
      `select v.id, v.channel_id, v.youtube_video_id,
              c.youtube_channel_id, v.title, v.description,
              v.duration_seconds,
              v.description_fetched_at is not null as metadata_ready
         from video_sources v
         join channel_sources c on c.id = v.channel_id
        where v.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      channelId: row.channel_id,
      youtubeVideoId: row.youtube_video_id,
      youtubeChannelId: row.youtube_channel_id,
      title: row.title ?? undefined,
      description: row.description ?? undefined,
      durationSeconds: row.duration_seconds ?? undefined,
      metadataReady: row.metadata_ready,
    } : undefined;
  }

  async upsertVideo(channelId: string, video: YouTubeVideo): Promise<StoredVideo> {
    const result = await this.pool.query<{ id: string; channel_id: string; youtube_video_id: string }>(
      `insert into video_sources (channel_id, youtube_video_id, title, description, etag, published_at, duration_seconds,
          availability, description_fetched_at, youtube_data_expires_at,
          unavailable_recheck_at, last_verified_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'available', now(), now() + interval '30 days', null, now())
       on conflict (youtube_video_id) do update set channel_id = excluded.channel_id, title = excluded.title,
         description = excluded.description, etag = excluded.etag, published_at = excluded.published_at,
         duration_seconds = excluded.duration_seconds, availability = 'available', description_fetched_at = now(),
         youtube_data_expires_at = now() + interval '30 days', unavailable_recheck_at = null,
         last_verified_at = now(), updated_at = now()
       returning id, channel_id, youtube_video_id`,
      [channelId, video.id, video.title.slice(0, 500), video.description, video.etag?.slice(0, 160) ?? null, video.publishedAt ? new Date(video.publishedAt) : null, video.durationSeconds ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Video upsert returned no row.");
    return {
      id: row.id,
      channelId: row.channel_id,
      youtubeVideoId: row.youtube_video_id,
      youtubeChannelId: video.channelId,
      title: video.title,
      description: video.description,
      durationSeconds: video.durationSeconds,
      metadataReady: true,
    };
  }

  async markVideoUnavailable(videoId: string, correlationId: string): Promise<void> {
    await this.transaction(async (client) => {
      const current = await client.query<{ availability: string; had_restricted_data: boolean }>(
        `select v.availability,
                (v.title is not null or v.description is not null or v.etag is not null
                 or v.published_at is not null or v.duration_seconds is not null
                 or exists (select 1 from sightings s where s.video_id = v.id and s.raw_segment is not null)
                 or exists (
                   select 1 from source_reviews review
                    where review.video_id = v.id
                      and (
                        jsonb_array_length(review.rejected_rows) > 0
                        or jsonb_array_length(review.ignored_links) > 0
                        or jsonb_array_length(review.diagnostics) > 0
                      )
                 ))
                  as had_restricted_data
           from video_sources v where v.id = $1 for update`,
        [videoId],
      );
      if (!current.rows[0]) throw new Error("Video source does not exist.");
      await client.query(
        `update video_sources set title = null, description = null, etag = null, published_at = null,
           duration_seconds = null, availability = 'unavailable', description_fetched_at = null,
           youtube_data_expires_at = null, unavailable_recheck_at = now() + interval '30 days',
           last_verified_at = now(), updated_at = now() where id = $1`,
        [videoId],
      );
      await client.query("update sightings set raw_segment = null, last_verified_at = now(), updated_at = now() where video_id = $1", [videoId]);
      await client.query(
        `update source_reviews
            set rejected_rows = '[]'::jsonb,
                ignored_links = '[]'::jsonb,
                diagnostics = '[]'::jsonb,
                version = version + 1,
                updated_at = now()
          where video_id = $1::uuid`,
        [videoId],
      );
      if (
        current.rows[0].availability !== "unavailable" ||
        current.rows[0].had_restricted_data
      ) {
        await client.query(
          `insert into audit_events
             (actor_user_id, action, target_type, target_id, correlation_id,
              before_summary, after_summary)
           values
             (null, 'youtube_source.unavailable', 'video', $1, $2::uuid,
               $3::jsonb, $4::jsonb)`,
          [
            videoId,
            correlationId,
            JSON.stringify({
              availability: current.rows[0].availability,
              retainedSourceData: current.rows[0].had_restricted_data,
            }),
            JSON.stringify({ availability: "unavailable", retainedSourceData: false }),
          ],
        );
      }
    });
  }

  private async ensureProject(client: Queryable, url: string, name?: string, repository?: { owner: string; name: string }): Promise<string> {
    const identityUrl = repository
      ? `https://github.com/${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`
      : url;
    if (repository) {
      const existingRepository = await client.query<ProjectIdentityRow>(
        `select p.id, p.state, p.merged_into_project_id
           from repositories r
           join projects p on p.id = r.project_id
          where r.provider = 'github' and lower(r.owner) = $1 and lower(r.name) = $2
          limit 1 for update of p`,
        [repository.owner.toLowerCase(), repository.name.toLowerCase()],
      );
      if (existingRepository.rows[0]) {
        return this.resolveMergedProject(client, existingRepository.rows[0]);
      }
    }
    const existing = await client.query<ProjectIdentityRow>(
      "select id, state, merged_into_project_id from projects where normalized_primary_url = $1 limit 1 for update",
      [identityUrl],
    );
    if (existing.rows[0]) return this.resolveMergedProject(client, existing.rows[0]);
    const projectName = boundedName(name, url);
    const inserted = await client.query<ProjectIdentityRow>(
      `insert into projects (slug, name, normalized_primary_url, primary_url)
       values ($1, $2, $3, $4)
       on conflict (normalized_primary_url) do update set normalized_primary_url = excluded.normalized_primary_url
       returning id, state, merged_into_project_id`,
      [slugFor(projectName, identityUrl), projectName, identityUrl, identityUrl],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("Project upsert returned no row.");
    return this.resolveMergedProject(client, row);
  }

  private async resolveMergedProject(client: Queryable, initial: ProjectIdentityRow): Promise<string> {
    let current = initial;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth += 1) {
      if (current.state === "active") return current.id;
      if (current.state === "archived") {
        throw new Error("Archived projects cannot receive ingestion writes.");
      }
      if (!current.merged_into_project_id || visited.has(current.id)) {
        throw new Error("Merged project chain is invalid.");
      }
      visited.add(current.id);
      const target = await client.query<ProjectIdentityRow>(
        "select id, state, merged_into_project_id from projects where id = $1 limit 1 for update",
        [current.merged_into_project_id],
      );
      if (!target.rows[0]) throw new Error("Merged project target does not exist.");
      current = target.rows[0];
    }
    throw new Error("Merged project chain exceeded the safety limit.");
  }

  private async writableProjectId(client: Queryable, projectId: string): Promise<string> {
    const project = await client.query<ProjectIdentityRow>(
      "select id, state, merged_into_project_id from projects where id = $1 limit 1 for update",
      [projectId],
    );
    if (!project.rows[0]) throw new Error("Project does not exist.");
    return this.resolveMergedProject(client, project.rows[0]);
  }

  private async insertProjectLink(client: Queryable, projectId: string, link: ParsedLink): Promise<void> {
    await client.query(
      `insert into project_links (project_id, kind, original_url, normalized_url)
       values ($1, $2, $3, $4) on conflict (project_id, normalized_url) do nothing`,
      [projectId, link.kind === "github_repo" ? "repository" : "website", link.rawUrl, link.canonicalUrl],
    );
  }

  async ingestParsedVideo(
    video: StoredVideo,
    mentions: ParsedProjectMention[],
    parserVersion: string,
    purgeMissingRawSegments: boolean,
    correlationId: string,
  ): Promise<ParsedVideoTargets> {
    return this.transaction(async (client) => {
      const repositoryTargets = new Map<string, { projectId: string; url: string }>();
      const websiteTargets = new Map<string, { projectId: string; url: string }>();
      const currentKeys = new Set<string>();

      for (const mention of mentions) {
        const primary = mention.links[mention.primaryLinkIndex];
        if (!primary) continue;
        const repository = repositoryParts(primary);
        const projectId = await this.ensureProject(client, primary.canonicalUrl, mention.name, repository);
        for (const link of mention.links) {
          await this.insertProjectLink(client, projectId, link);
          if (link.kind === "github_repo") repositoryTargets.set(`${projectId}:${link.githubRepoKey}`, { projectId, url: link.canonicalUrl });
        }
        if (primary.kind === "website") websiteTargets.set(`${projectId}:${primary.canonicalUrl}`, { projectId, url: primary.canonicalUrl });

        await client.query(
          `insert into sightings (project_id, channel_id, video_id, timestamp_seconds, timestamp_label, raw_segment,
             original_url, normalized_url, parser_version, source_position, last_verified_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           on conflict (video_id, timestamp_seconds, normalized_url) do update
             set project_id = excluded.project_id, channel_id = excluded.channel_id,
                 timestamp_label = excluded.timestamp_label, raw_segment = excluded.raw_segment,
                 original_url = excluded.original_url, parser_version = excluded.parser_version,
                 source_position = excluded.source_position, last_verified_at = now(), updated_at = now()`,
          [projectId, video.channelId, video.id, mention.timestampSeconds, mention.timestampText.slice(0, 16), mention.rawSegment, primary.rawUrl, primary.canonicalUrl, parserVersion.slice(0, 32), mention.ordinal],
        );
        currentKeys.add(`${mention.timestampSeconds}\u0000${primary.canonicalUrl}`);
      }

      let purgedRawSegmentCount = 0;
      if (purgeMissingRawSegments) {
        const existing = await client.query<{ id: string; timestamp_seconds: number; normalized_url: string }>(
          "select id, timestamp_seconds, normalized_url from sightings where video_id = $1 and raw_segment is not null",
          [video.id],
        );
        for (const row of existing.rows) {
          if (!currentKeys.has(`${row.timestamp_seconds}\u0000${row.normalized_url}`)) {
            await client.query("update sightings set raw_segment = null, updated_at = now() where id = $1", [row.id]);
            purgedRawSegmentCount += 1;
          }
        }
      }
      if (purgedRawSegmentCount > 0) {
        await client.query(
          `insert into audit_events
             (actor_user_id, action, target_type, target_id, correlation_id,
              before_summary, after_summary)
           values
             (null, 'youtube_source.raw_segments_purged', 'video', $1, $2::uuid,
              $3::jsonb, $4::jsonb)`,
          [
            video.id,
            correlationId,
            JSON.stringify({ retainedRawSegmentCount: purgedRawSegmentCount }),
            JSON.stringify({ retainedRawSegmentCount: 0 }),
          ],
        );
      }
      return { repositoryTargets: [...repositoryTargets.values()], websiteTargets: [...websiteTargets.values()] };
    });
  }

  async recordSourceReview(
    videoId: string,
    jobId: string,
    parsed: ParseDescriptionResult,
  ): Promise<void> {
    const warningCount = parsed.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning",
    ).length;
    const errorCount = parsed.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    ).length;
    const issueFingerprint = createHash("sha256")
      .update(JSON.stringify({
        mentions: parsed.mentions.length,
        rejectedRows: parsed.rejectedRows,
        ignoredLinks: parsed.ignoredLinks,
        diagnostics: parsed.diagnostics,
      }))
      .digest("hex");
    const hasReviewableIssue =
      parsed.mentions.length === 0 ||
      warningCount > 0 ||
      errorCount > 0 ||
      parsed.rejectedRows.length > 0 ||
      parsed.ignoredLinks.length > 0;

    if (!hasReviewableIssue) {
      await this.pool.query(
        `update source_reviews
            set state = 'resolved', ingestion_job_id = $2::uuid,
                parser_version = $3, issue_fingerprint = $4,
                version = version + 1,
                mention_count = $5, warning_count = 0, error_count = 0,
                rejected_rows = '[]'::jsonb, ignored_links = '[]'::jsonb,
                diagnostics = '[]'::jsonb, resolved_at = now(),
                resolved_by_user_id = null, resolution_note = null,
                updated_at = now()
          where video_id = $1::uuid`,
        [videoId, jobId, parsed.parserVersion, issueFingerprint, parsed.mentions.length],
      );
      return;
    }

    await this.pool.query(
      `insert into source_reviews
        (video_id, ingestion_job_id, state, parser_version, issue_fingerprint,
         mention_count, warning_count, error_count, rejected_rows,
         ignored_links, diagnostics)
       values ($1::uuid, $2::uuid, 'open', $3, $4, $5, $6, $7,
               $8::jsonb, $9::jsonb, $10::jsonb)
       on conflict (video_id) do update
         set ingestion_job_id = excluded.ingestion_job_id,
             state = case
               when source_reviews.issue_fingerprint = excluded.issue_fingerprint
                 and source_reviews.state = 'ignored'
               then 'ignored'::source_review_state
               else 'open'::source_review_state
             end,
             parser_version = excluded.parser_version,
             issue_fingerprint = excluded.issue_fingerprint,
             version = source_reviews.version + 1,
             mention_count = excluded.mention_count,
             warning_count = excluded.warning_count,
             error_count = excluded.error_count,
             rejected_rows = excluded.rejected_rows,
             ignored_links = excluded.ignored_links,
             diagnostics = excluded.diagnostics,
             resolved_at = case
               when source_reviews.issue_fingerprint = excluded.issue_fingerprint
                 and source_reviews.state = 'ignored'
               then source_reviews.resolved_at
               else null
             end,
             resolved_by_user_id = case
               when source_reviews.issue_fingerprint = excluded.issue_fingerprint
                 and source_reviews.state = 'ignored'
               then source_reviews.resolved_by_user_id
               else null
             end,
             resolution_note = case
               when source_reviews.issue_fingerprint = excluded.issue_fingerprint
                 and source_reviews.state = 'ignored'
               then source_reviews.resolution_note
               else null
             end,
             updated_at = now()`,
      [
        videoId,
        jobId,
        parsed.parserVersion,
        issueFingerprint,
        parsed.mentions.length,
        warningCount,
        errorCount,
        JSON.stringify(parsed.rejectedRows),
        JSON.stringify(parsed.ignoredLinks),
        JSON.stringify(parsed.diagnostics),
      ],
    );
  }

  async ensureWebsiteProject(projectId: string | undefined, url: string, title?: string): Promise<string> {
    return this.transaction(async (client) => {
      const targetProjectId = projectId
        ? await this.writableProjectId(client, projectId)
        : await this.ensureProject(client, url, title);
      await client.query(
        `insert into project_links (project_id, kind, original_url, normalized_url)
         values ($1, 'website', $2, $2) on conflict (project_id, normalized_url) do nothing`,
        [targetProjectId, url],
      );
      return targetProjectId;
    });
  }

  async applyWebsiteMetadata(projectId: string, metadata: WebsiteMetadata): Promise<void> {
    await this.transaction(async (client) => {
      const targetProjectId = await this.writableProjectId(client, projectId);
      await client.query(
        `update projects set description = coalesce(description, $2), logo_url = coalesce(logo_url, $3), updated_at = now()
         where id = $1`,
        [targetProjectId, metadata.description?.slice(0, 10_000) ?? null, metadata.iconUrl ?? metadata.openGraph.imageUrl ?? null],
      );
      for (const url of new Set([metadata.requestedUrl, metadata.finalUrl])) {
        await client.query(
          `insert into project_links (project_id, kind, original_url, normalized_url, verification_state, verified_at)
           values ($1, 'website', $2, $2, 'verified', now())
           on conflict (project_id, normalized_url) do update set verification_state='verified', verified_at=now(), updated_at=now()`,
          [targetProjectId, url],
        );
      }
    });
  }

  async getRepository(id: string): Promise<StoredRepository | undefined> {
    const result = await this.pool.query<{ id: string; project_id: string; owner: string; name: string }>(
      "select id, project_id, owner, name from repositories where id = $1",
      [id],
    );
    const row = result.rows[0];
    return row ? { id: row.id, projectId: row.project_id, owner: row.owner, name: row.name } : undefined;
  }

  private repositoryValues(repository: GitHubRepositoryMetadata): unknown[] {
    return [repository.providerRepositoryId, repository.owner, repository.name, repository.canonicalUrl, repository.homepageUrl ?? null,
      repository.description ?? null, repository.defaultBranch ?? null, repository.headSha ?? null, JSON.stringify(repository.topics),
      repository.primaryLanguage ?? null, JSON.stringify(repository.languages), repository.licenseSpdx ?? null, repository.stars,
      repository.forks, repository.openIssues, repository.archived, repository.fork, repository.pushedAt ? new Date(repository.pushedAt) : null,
      repository.latestReleaseAt ? new Date(repository.latestReleaseAt) : null];
  }

  private async recordRepositoryIdentityConflict(
    client: Queryable,
    projectId: string,
    repository: GitHubRepositoryMetadata,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    const evidenceJson = JSON.stringify({
      ...evidence,
      providerRepositoryId: repository.providerRepositoryId,
      repositoryUrl: repository.canonicalUrl,
    });
    const evidenceHash = createHash("sha256").update(evidenceJson).digest("hex");
    await client.query(
      `insert into repository_candidates
         (project_id, provider, provider_repository_id, owner, name,
          canonical_url, discovery_method, evidence_hash, evidence,
          score_basis_points)
       values ($1, 'github', $2, $3, $4, $5,
               'verified_identity_conflict', $6, $7::jsonb, 10000)
       on conflict (project_id, provider, owner, name, evidence_hash) do nothing`,
      [
        projectId,
        repository.providerRepositoryId,
        repository.owner,
        repository.name,
        repository.canonicalUrl,
        evidenceHash,
        evidenceJson,
      ],
    );
    await client.query(
      "update projects set review_state = 'needs_review', updated_at = now() where id = $1",
      [projectId],
    );
  }

  async attachRepository(projectId: string | undefined, repository: GitHubRepositoryMetadata): Promise<string> {
    return this.transaction(async (client) => {
      const requestedProjectId = projectId
        ? await this.writableProjectId(client, projectId)
        : undefined;
      const providerMatchResult = await client.query<ExistingRepositoryRow>(
        `select id, project_id, provider_repository_id from repositories
          where provider = 'github' and provider_repository_id = $1
          limit 1 for update`,
        [repository.providerRepositoryId],
      );
      const nameMatchResult = await client.query<ExistingRepositoryRow>(
        `select id, project_id, provider_repository_id from repositories
          where provider = 'github' and lower(owner) = $1 and lower(name) = $2
          limit 1 for update`,
        [repository.owner.toLowerCase(), repository.name.toLowerCase()],
      );
      const providerMatch = providerMatchResult.rows[0];
      const nameMatch = nameMatchResult.rows[0];

      if (
        (providerMatch && nameMatch && providerMatch.id !== nameMatch.id) ||
        (!providerMatch && nameMatch && nameMatch.provider_repository_id !== repository.providerRepositoryId)
      ) {
        const identityOwner = providerMatch ?? nameMatch;
        const identityProjectId = await this.writableProjectId(client, identityOwner.project_id);
        const candidateProjectId = requestedProjectId ?? identityProjectId;
        await this.recordRepositoryIdentityConflict(client, candidateProjectId, repository, {
          reason: providerMatch ? "repository_identity_split" : "repository_name_reused",
          existingProjectId: identityProjectId,
          conflictingProjectId: providerMatch && nameMatch ? nameMatch.project_id : undefined,
        });
        return candidateProjectId;
      }

      const existing = providerMatch ?? nameMatch;
      const existingProjectId = existing
        ? await this.writableProjectId(client, existing.project_id)
        : undefined;
      if (
        requestedProjectId &&
        existingProjectId &&
        requestedProjectId !== existingProjectId
      ) {
        await this.recordRepositoryIdentityConflict(client, requestedProjectId, repository, {
          reason: "repository_attached_elsewhere",
          existingProjectId,
        });
        return requestedProjectId;
      }
      const targetProjectId = existingProjectId ?? requestedProjectId ?? await this.ensureProject(client, repository.canonicalUrl, repository.name, repository);
      const values = [targetProjectId, ...this.repositoryValues(repository)];
      const saved = existing
        ? await client.query<{ id: string }>(
            `update repositories set provider_repository_id=$2, owner=$3, name=$4, canonical_url=$5,
               homepage_url=$6, description=$7, default_branch=$8, head_sha=$9, topics=$10::jsonb,
               primary_language=$11, languages=$12::jsonb, license_spdx=$13, stars=$14, forks=$15,
               open_issues=$16, archived=$17, fork=$18, pushed_at=$19, latest_release_at=$20,
               metadata_refreshed_at=now(), refresh_error_summary=null, updated_at=now()
             where id=$1 returning id`,
            [existing.id, ...this.repositoryValues(repository)],
          )
        : await client.query<{ id: string }>(
            `insert into repositories (project_id, provider, provider_repository_id, owner, name, canonical_url, homepage_url,
               description, default_branch, head_sha, topics, primary_language, languages, license_spdx, stars, forks,
               open_issues, archived, fork, pushed_at, latest_release_at, metadata_refreshed_at)
             values ($1, 'github', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, now()) returning id`,
            values,
          );
      const repositoryId = saved.rows[0]?.id;
      if (!repositoryId) throw new Error("Repository upsert returned no row.");
      await client.query("update projects set primary_repository_id = coalesce(primary_repository_id, $2), updated_at = now() where id = $1", [targetProjectId, repositoryId]);
      await client.query(
        `insert into project_links (project_id, kind, original_url, normalized_url, verification_state, verified_at)
         values ($1, 'repository', $2, $2, 'verified', now())
         on conflict (project_id, normalized_url) do update set verification_state='verified', verified_at=now(), updated_at=now()`,
        [targetProjectId, repository.canonicalUrl],
      );
      return targetProjectId;
    });
  }

  async refreshRepository(repositoryId: string, repository: GitHubRepositoryMetadata): Promise<void> {
    const values = this.repositoryValues(repository);
    await this.pool.query(
      `update repositories set provider_repository_id=$2, owner=$3, name=$4, canonical_url=$5, homepage_url=$6,
         description=$7, default_branch=$8, head_sha=$9, topics=$10::jsonb, primary_language=$11, languages=$12::jsonb,
         license_spdx=$13, stars=$14, forks=$15, open_issues=$16, archived=$17, fork=$18, pushed_at=$19,
         latest_release_at=$20, metadata_refreshed_at=now(), refresh_error_summary=null, updated_at=now() where id=$1`,
      [repositoryId, ...values],
    );
  }

  async markRepositoryRefreshError(repositoryId: string, summary: string): Promise<void> {
    await this.pool.query(
      "update repositories set refresh_error_summary=$2, updated_at=now() where id=$1",
      [repositoryId, summary.slice(0, 500)],
    );
  }

  async addRepositoryCandidates(candidates: CandidateInput[]): Promise<void> {
    await this.transaction(async (client) => {
      for (const candidate of candidates) {
        const projectId = await this.writableProjectId(client, candidate.projectId);
        const evidenceJson = JSON.stringify(candidate.evidence);
        const evidenceHash = createHash("sha256").update(evidenceJson).digest("hex");
        await client.query(
          `insert into repository_candidates (project_id, provider, provider_repository_id, owner, name, canonical_url,
             discovery_method, evidence_hash, evidence, score_basis_points)
           values ($1, 'github', $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           on conflict (project_id, provider, owner, name, evidence_hash) do nothing`,
          [projectId, candidate.repository.providerRepositoryId, candidate.repository.owner, candidate.repository.name,
            candidate.repository.canonicalUrl, candidate.discoveryMethod.slice(0, 80), evidenceHash, evidenceJson,
            Math.max(0, Math.min(10_000, candidate.scoreBasisPoints))],
        );
      }
    });
  }

  async updateJobProgress(jobId: string, completedItems: number, totalItems: number, warningCount = 0): Promise<void> {
    const total = Math.max(0, totalItems);
    await this.pool.query(
      "update ingestion_jobs set total_items=$2, completed_items=$3, warning_count=$4, updated_at=now() where id=$1",
      [jobId, total, Math.max(0, Math.min(total, completedItems)), Math.max(0, warningCount)],
    );
  }
}
