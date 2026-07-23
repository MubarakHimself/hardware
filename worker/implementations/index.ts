import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SafeFetchError,
  fetchWebsiteMetadata,
  normalizeProjectUrl,
  parseYouTubeDescription,
  type WebsiteMetadata,
} from "../../lib/ingestion";
import {
  GitHubClient,
  IntegrationError,
  YouTubeClient,
  parseGitHubRepositoryReference,
  parseYouTubeVideoId,
  type GitHubRepositoryMetadata,
} from "../../lib/integrations";
import { SafeJobError, trackedJobPayloadSchema, type TrackedJobPayload } from "../jobs";
import type { TaskImplementation, TaskImplementations } from "../tasks";
import type { EnqueueChildJob, IngestionStore, StoredVideo } from "./contracts";

const channelResolvePayloadSchema = trackedJobPayloadSchema.extend({
  url: z.url().max(4_096),
  requestedByUserId: z.uuid().optional(),
});

const channelPayloadSchema = trackedJobPayloadSchema.extend({
  channelSourceId: z.uuid(),
  historyMode: z.enum(["latest_10", "latest_25", "latest_50", "since", "all"]).optional(),
  historySince: z.iso.datetime({ offset: true }).optional(),
}).refine(
  (value) => value.historyMode !== "since" || Boolean(value.historySince),
  "A since date is required for since-mode backfills.",
);
const videoPayloadSchema = trackedJobPayloadSchema.extend({
  videoSourceId: z.uuid().optional(),
  url: z.string().max(4_096).optional(),
  parentJobId: z.uuid().optional(),
  useStoredMetadata: z.boolean().optional(),
  sourceUnavailable: z.boolean().optional(),
});
const websitePayloadSchema = trackedJobPayloadSchema.extend({
  projectId: z.uuid().optional(),
  url: z.url().max(4_096),
  parentJobId: z.uuid().optional(),
});
const repositoryResolvePayloadSchema = trackedJobPayloadSchema.extend({
  projectId: z.uuid().optional(),
  url: z.string().max(4_096).optional(),
  repositoryUrl: z.string().max(4_096).optional(),
  query: z.string().max(200).optional(),
  candidateOnly: z.boolean().optional(),
  discoveryMethod: z.string().max(80).optional(),
  parentJobId: z.uuid().optional(),
});
const repositoryRefreshPayloadSchema = trackedJobPayloadSchema.extend({ repositoryId: z.uuid() });

export interface TaskImplementationDependencies {
  store: IngestionStore;
  youtube: Pick<
    YouTubeClient,
    | "resolveChannel"
    | "getChannelById"
    | "getVideo"
    | "getVideos"
    | "listUploadsPage"
  >;
  github: Pick<GitHubClient, "getRepository" | "searchRepositories">;
  enqueue: EnqueueChildJob;
  fetchWebsite?: (url: string) => Promise<WebsiteMetadata>;
  maximumChannelPages?: number;
}

function taskError(error: unknown): never {
  if (error instanceof SafeJobError) throw error;
  if (error instanceof IntegrationError) throw new SafeJobError(error.code, error.message, error.retryable);
  if (error instanceof SafeFetchError) {
    const retryable = error.code === "TIMEOUT" || error.code === "FETCH_FAILED" || error.code === "DNS_RESOLUTION_FAILED" || (error.code === "HTTP_STATUS" && (error.status === 429 || (error.status ?? 0) >= 500));
    throw new SafeJobError(`WEBSITE_${error.code}`, error.message, retryable);
  }
  throw error;
}

function safeSourceError(error: unknown, fallbackCode: string, fallbackMessage: string): { code: string; message: string } {
  if (error instanceof SafeJobError || error instanceof IntegrationError) {
    return { code: error.code, message: error.message.slice(0, 500) };
  }
  if (error instanceof SafeFetchError) {
    return { code: `WEBSITE_${error.code}`, message: error.message.slice(0, 500) };
  }
  return { code: fallbackCode, message: fallbackMessage };
}

function childBucket(...parts: string[]): string {
  return `v1:${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}`;
}

function scoreCandidate(query: string, repository: GitHubRepositoryMetadata): number {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const repositoryName = repository.name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (normalized && normalized === repositoryName) return 9_000;
  if (normalized && (repositoryName.includes(normalized) || normalized.includes(repositoryName))) return 7_000;
  return 4_000;
}

export function createTaskImplementations(dependencies: TaskImplementationDependencies): TaskImplementations {
  const { store, youtube, github, enqueue } = dependencies;
  const websiteFetcher = dependencies.fetchWebsite ?? ((url: string) => fetchWebsiteMetadata(url));
  const maximumChannelPages = Math.max(1, Math.min(dependencies.maximumChannelPages ?? 10_000, 10_000));

  const resolveChannelSubscription: TaskImplementation = async (rawPayload) => {
    const payload = channelResolvePayloadSchema.parse(rawPayload);
    try {
      const resolved = await youtube.resolveChannel(payload.url);
      const subscription = await store.ensureChannelSubscription(resolved, {
        subscriptionJobId: payload.jobId,
        requestedByUserId: payload.requestedByUserId,
      });
      if (subscription.backfillPending) {
        const subscriptionJobId = subscription.subscriptionJobId;
        if (!subscriptionJobId) {
          throw new SafeJobError(
            "CHANNEL_SUBSCRIPTION_STATE_INVALID",
            "The pending channel subscription has no durable job identity.",
            true,
          );
        }
        await enqueue(
          "channel_backfill",
          {
            scopeType: "channel",
            scopeId: subscription.channel.id,
            payload: {
              channelSourceId: subscription.channel.id,
              historyMode: "latest_25",
              subscriptionJobId,
            },
            queueName: `channel:${subscription.channel.id}`,
          },
          childBucket("channel-subscription", subscriptionJobId),
        );
        const confirmed = await store.confirmChannelSubscriptionBackfill(
          subscription.channel.id,
          subscriptionJobId,
          payload.jobId,
        );
        if (!confirmed) {
          throw new SafeJobError(
            "CHANNEL_BACKFILL_LANE_BUSY",
            "The channel subscription is durable but its initial backfill is waiting for the channel lane.",
            true,
          );
        }
      }
      await store.updateJobProgress(payload.jobId, 1, 1);
    } catch (error) {
      taskError(error);
    }
  };

  const syncChannel = (backfill: boolean): TaskImplementation => async (rawPayload) => {
    const payload = channelPayloadSchema.parse(rawPayload);
    try {
      const channel = await store.getChannel(payload.channelSourceId);
      if (!channel) throw new SafeJobError("CHANNEL_SOURCE_NOT_FOUND", "The channel source does not exist or is disabled.", false);
      const previousLastSeen = typeof channel.checkpoint.lastSeenVideoId === "string" ? channel.checkpoint.lastSeenVideoId : undefined;
      const seenPageTokens = new Set<string>();
      let pageToken: string | undefined;
      let firstVideoId: string | undefined;
      let completed = 0;
      let stop = false;
      let pageLimitExceeded = false;
      const historyLimit = backfill
        ? payload.historyMode === "latest_10"
          ? 10
          : payload.historyMode === "latest_50"
            ? 50
            : payload.historyMode === "all"
              ? Number.POSITIVE_INFINITY
              : payload.historyMode === "since"
                ? Number.POSITIVE_INFINITY
                : 25
        : Number.POSITIVE_INFINITY;
      const historySince = payload.historySince
        ? new Date(payload.historySince).getTime()
        : undefined;

      for (let pageNumber = 0; pageNumber < maximumChannelPages && !stop; pageNumber += 1) {
        const page = await youtube.listUploadsPage(channel.uploadsPlaylistId, pageToken);
        firstVideoId ??= page.items[0]?.videoId;
        const selectedUploads: typeof page.items = [];
        for (const upload of page.items) {
          if (!backfill && previousLastSeen && upload.videoId === previousLastSeen) {
            stop = true;
            break;
          }
          if (
            backfill &&
            historySince !== undefined &&
            upload.publishedAt &&
            new Date(upload.publishedAt).getTime() < historySince
          ) {
            stop = true;
            break;
          }
          if (backfill && completed + selectedUploads.length >= historyLimit) {
            stop = true;
            break;
          }
          selectedUploads.push(upload);
        }

        // Playlist pages contain at most 50 uploads, which exactly matches the
        // YouTube videos.list batch limit. Persist the metadata once here and
        // keep parsing in independent child jobs for isolation and retryability.
        const metadataByVideoId = new Map(
          (await youtube.getVideos(selectedUploads.map((upload) => upload.videoId)))
            .map((metadata) => [metadata.id, metadata] as const),
        );
        for (const upload of selectedUploads) {
          let video = await store.upsertDiscoveredVideo(channel.id, upload);
          const metadata = metadataByVideoId.get(upload.videoId);
          if (metadata) {
            video = await store.upsertVideo(channel.id, metadata);
          }
          await enqueue(
            "video_ingest",
            {
              scopeType: "video",
              scopeId: video.id,
              payload: {
                videoSourceId: video.id,
                parentJobId: payload.jobId,
                ...(metadata
                  ? { useStoredMetadata: true }
                  : { sourceUnavailable: true }),
              },
              queueName: `video:${video.id}`,
            },
            childBucket("channel-video", payload.jobId, video.youtubeVideoId),
          );
          completed += 1;
          await store.updateJobProgress(payload.jobId, 0, completed);
        }
        if (stop || !page.nextPageToken) break;
        if (pageNumber === maximumChannelPages - 1) {
          pageLimitExceeded = true;
          break;
        }
        if (seenPageTokens.has(page.nextPageToken)) throw new SafeJobError("YOUTUBE_PAGINATION_LOOP", "YouTube returned a repeated playlist page token.", true);
        seenPageTokens.add(page.nextPageToken);
        pageToken = page.nextPageToken;
      }
      if (pageLimitExceeded) throw new SafeJobError("YOUTUBE_PAGE_LIMIT_EXCEEDED", "The channel exceeded the bounded page limit; the checkpoint was not advanced.", true);
      await store.completeChannelSync(
        channel.id,
        {
          ...channel.checkpoint,
          lastSeenVideoId: firstVideoId ?? previousLastSeen ?? null,
          syncedAt: new Date().toISOString(),
        },
        payload.jobId,
      );
    } catch (error) {
      const safe = safeSourceError(error, "CHANNEL_SYNC_FAILED", "Channel synchronization failed; review the correlated ingestion event.");
      await store.markChannelError(payload.channelSourceId, safe.code, safe.message).catch(() => undefined);
      taskError(error);
    }
  };

  const ingestVideo = async (rawPayload: TrackedJobPayload, purgeMissingRawSegments: boolean): Promise<void> => {
    const payload = videoPayloadSchema.parse(rawPayload);
    try {
      let storedVideo: StoredVideo | undefined;
      let youtubeVideoId: string;
      if (payload.videoSourceId) {
        storedVideo = await store.getVideo(payload.videoSourceId);
        if (!storedVideo) throw new SafeJobError("VIDEO_SOURCE_NOT_FOUND", "The video source does not exist.", false);
        youtubeVideoId = storedVideo.youtubeVideoId;
      } else if (payload.url) {
        youtubeVideoId = parseYouTubeVideoId(payload.url);
      } else {
        throw new SafeJobError("VIDEO_REFERENCE_REQUIRED", "A YouTube video source or URL is required.", false);
      }

      if (payload.sourceUnavailable) {
        if (!storedVideo) {
          throw new SafeJobError("VIDEO_SOURCE_NOT_FOUND", "The unavailable video source does not exist.", false);
        }
        await store.markVideoUnavailable(storedVideo.id, payload.correlationId);
        await store.updateJobProgress(payload.jobId, 1, 1);
        return;
      }

      const useStoredMetadata = Boolean(
        payload.useStoredMetadata &&
        storedVideo?.metadataReady &&
        storedVideo.youtubeChannelId &&
        storedVideo.title !== undefined &&
        storedVideo.description !== undefined,
      );
      const source = useStoredMetadata && storedVideo
        ? {
            id: storedVideo.youtubeVideoId,
            channelId: storedVideo.youtubeChannelId!,
            title: storedVideo.title!,
            description: storedVideo.description!,
            durationSeconds: storedVideo.durationSeconds,
          }
        : await youtube.getVideo(youtubeVideoId);
      if (!source) {
        if (storedVideo) {
          await store.markVideoUnavailable(storedVideo.id, payload.correlationId);
          await store.updateJobProgress(payload.jobId, 1, 1);
          return;
        }
        throw new SafeJobError("YOUTUBE_VIDEO_UNAVAILABLE", "The YouTube video is unavailable.", false);
      }
      if (!storedVideo) {
        const channel = await youtube.getChannelById(source.channelId);
        const storedChannel = await store.upsertChannel(channel, {
          monitoringEnabled: false,
        });
        storedVideo = await store.upsertVideo(storedChannel.id, source);
      } else if (!useStoredMetadata) {
        storedVideo = await store.upsertVideo(storedVideo.channelId, source);
      }
      const parsed = parseYouTubeDescription({ videoId: source.id, description: source.description, durationSeconds: source.durationSeconds });
      const targets = await store.ingestParsedVideo(
        storedVideo,
        parsed.mentions,
        parsed.parserVersion,
        purgeMissingRawSegments,
        payload.correlationId,
      );
      await store.recordSourceReview(storedVideo.id, payload.jobId, parsed);

      for (const target of targets.repositoryTargets) {
        const reference = parseGitHubRepositoryReference(target.url);
        await enqueue("repository_resolve", {
          scopeType: "project", scopeId: target.projectId,
          payload: {
            projectId: target.projectId,
            repositoryUrl: target.url,
            discoveryMethod: "youtube_explicit_url",
            parentJobId: payload.jobId,
          },
          queueName: `project:${target.projectId}`,
        }, childBucket("repository", reference.owner, reference.name));
      }
      for (const target of targets.websiteTargets) {
        await enqueue("website_metadata", {
          scopeType: "project", scopeId: target.projectId,
          payload: { projectId: target.projectId, url: target.url, parentJobId: payload.jobId },
          queueName: `project:${target.projectId}`,
        }, childBucket("website", target.url));
      }
      const warningCount = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
      await store.updateJobProgress(payload.jobId, parsed.mentions.length, parsed.mentions.length, warningCount);
    } catch (error) { taskError(error); }
  };

  const websiteMetadata: TaskImplementation = async (rawPayload) => {
    const payload = websitePayloadSchema.parse(rawPayload);
    try {
      const normalized = normalizeProjectUrl(payload.url);
      if (!normalized.ok) throw new SafeJobError(`WEBSITE_${normalized.code}`, normalized.message, false);
      const metadata = await websiteFetcher(normalized.link.canonicalUrl);
      const projectId = await store.ensureWebsiteProject(payload.projectId, normalized.link.canonicalUrl, metadata.title ?? metadata.openGraph.title);
      await store.applyWebsiteMetadata(projectId, metadata);
      const repositories = metadata.githubRepositories;
      for (const repository of repositories) {
        await enqueue("repository_resolve", {
          scopeType: "project", scopeId: projectId,
          payload: {
            projectId,
            repositoryUrl: repository.url,
            candidateOnly: repositories.length !== 1,
            discoveryMethod: repositories.length === 1 ? "website_unambiguous" : "website_ambiguous",
            parentJobId: payload.jobId,
          },
          queueName: `project:${projectId}`,
        }, childBucket("website-repository", projectId, repository.repoKey));
      }
      await store.updateJobProgress(payload.jobId, 1, 1, repositories.length > 1 ? 1 : 0);
    } catch (error) { taskError(error); }
  };

  const repositoryResolve: TaskImplementation = async (rawPayload) => {
    const payload = repositoryResolvePayloadSchema.parse(rawPayload);
    try {
      const explicitUrl = payload.repositoryUrl ?? payload.url;
      if (explicitUrl) {
        const repository = await github.getRepository(explicitUrl);
        if (payload.candidateOnly) {
          if (!payload.projectId) throw new SafeJobError("PROJECT_REFERENCE_REQUIRED", "A project is required for repository review candidates.", false);
          await store.addRepositoryCandidates([{
            projectId: payload.projectId,
            repository,
            discoveryMethod: payload.discoveryMethod ?? "ambiguous_url",
            evidence: { repositoryUrl: explicitUrl, source: payload.discoveryMethod ?? "ambiguous_url" },
            scoreBasisPoints: 8_000,
          }]);
        } else {
          await store.attachRepository(payload.projectId, repository);
        }
        await store.updateJobProgress(payload.jobId, 1, 1);
        return;
      }
      if (!payload.projectId || !payload.query) throw new SafeJobError("REPOSITORY_RESOLUTION_INPUT_REQUIRED", "Repository resolution requires an exact URL or a project search query.", false);
      const results = await github.searchRepositories(payload.query, 5);
      await store.addRepositoryCandidates(results.map((repository) => ({
        projectId: payload.projectId!, repository, discoveryMethod: payload.discoveryMethod ?? "github_search",
        evidence: { query: payload.query, source: payload.discoveryMethod ?? "github_search" },
        scoreBasisPoints: scoreCandidate(payload.query!, repository),
      })));
      await store.updateJobProgress(payload.jobId, results.length, results.length);
    } catch (error) { taskError(error); }
  };

  const repositoryRefresh: TaskImplementation = async (rawPayload) => {
    const payload = repositoryRefreshPayloadSchema.parse(rawPayload);
    try {
      const repository = await store.getRepository(payload.repositoryId);
      if (!repository) throw new SafeJobError("REPOSITORY_NOT_FOUND", "The repository record does not exist.", false);
      const metadata = await github.getRepository(`${repository.owner}/${repository.name}`);
      await store.refreshRepository(repository.id, metadata);
      await store.updateJobProgress(payload.jobId, 1, 1);
    } catch (error) {
      const safe = safeSourceError(error, "REPOSITORY_REFRESH_FAILED", "Repository refresh failed; the last good metadata was retained.");
      await store.markRepositoryRefreshError(payload.repositoryId, safe.message).catch(() => undefined);
      taskError(error);
    }
  };

  return {
    channel_resolve: resolveChannelSubscription,
    channel_backfill: syncChannel(true),
    channel_poll: syncChannel(false),
    video_ingest: (payload) => ingestVideo(payload, false),
    youtube_revalidate: (payload) => ingestVideo(payload, true),
    website_metadata: websiteMetadata,
    repository_resolve: repositoryResolve,
    repository_refresh: repositoryRefresh,
  };
}

export type { CandidateInput, EnqueueChildJob, IngestionStore, StoredChannel, StoredRepository, StoredVideo } from "./contracts";
export { PgIngestionStore } from "./pg-store";
