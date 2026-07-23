import type { JobHelpers } from "graphile-worker";
import { describe, expect, it, vi } from "vitest";
import type { WebsiteMetadata } from "../../lib/ingestion";
import { IntegrationError, type GitHubRepositoryMetadata, type YouTubeChannel, type YouTubeUploadsPage, type YouTubeVideo } from "../../lib/integrations";
import { createTaskImplementations, type IngestionStore } from "../../worker/implementations";
import type { TaskImplementationDependencies } from "../../worker/implementations";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const VIDEO_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const REPOSITORY_ID = "66666666-6666-4666-8666-666666666666";
const helpers = {} as JobHelpers;

const channel: YouTubeChannel = {
  id: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
  uploadsPlaylistId: "UU_x5XG1OV2P6uZZ5FSM9Ttw",
  title: "Channel",
  canonicalUrl: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
};

const video: YouTubeVideo = {
  id: "KITOm0HitpY",
  channelId: channel.id,
  title: "Projects",
  description: "0:00 Acme Tool https://github.com/acme/tool",
  durationSeconds: 60,
};

const repository: GitHubRepositoryMetadata = {
  providerRepositoryId: "42",
  owner: "acme",
  name: "tool",
  canonicalUrl: "https://github.com/acme/tool",
  topics: [],
  languages: {},
  stars: 10,
  forks: 1,
  openIssues: 0,
  archived: false,
  fork: false,
};

function createStore(): IngestionStore {
  return {
    getChannel: vi.fn(async () => ({ id: CHANNEL_ID, youtubeChannelId: channel.id, uploadsPlaylistId: channel.uploadsPlaylistId, checkpoint: {} })),
    upsertChannel: vi.fn(async () => ({ id: CHANNEL_ID, youtubeChannelId: channel.id, uploadsPlaylistId: channel.uploadsPlaylistId, checkpoint: {} })),
    ensureChannelSubscription: vi.fn(async () => ({
      channel: { id: CHANNEL_ID, youtubeChannelId: channel.id, uploadsPlaylistId: channel.uploadsPlaylistId, checkpoint: {} },
      backfillPending: true,
      subscriptionJobId: JOB_ID,
    })),
    confirmChannelSubscriptionBackfill: vi.fn(async () => true),
    upsertDiscoveredVideo: vi.fn(async (_channelId, upload) => ({ id: VIDEO_ID, channelId: CHANNEL_ID, youtubeVideoId: upload.videoId })),
    completeChannelSync: vi.fn(async () => undefined),
    markChannelError: vi.fn(async () => undefined),
    getVideo: vi.fn(async () => ({
      id: VIDEO_ID,
      channelId: CHANNEL_ID,
      youtubeVideoId: video.id,
      youtubeChannelId: video.channelId,
      title: video.title,
      description: video.description,
      durationSeconds: video.durationSeconds,
      metadataReady: true,
    })),
    upsertVideo: vi.fn(async (_channelId, source) => ({
      id: VIDEO_ID,
      channelId: CHANNEL_ID,
      youtubeVideoId: source.id,
      youtubeChannelId: source.channelId,
      title: source.title,
      description: source.description,
      durationSeconds: source.durationSeconds,
      metadataReady: true,
    })),
    markVideoUnavailable: vi.fn(async () => undefined),
    ingestParsedVideo: vi.fn(async () => ({ repositoryTargets: [], websiteTargets: [] })),
    recordSourceReview: vi.fn(async () => undefined),
    ensureWebsiteProject: vi.fn(async () => PROJECT_ID),
    applyWebsiteMetadata: vi.fn(async () => undefined),
    getRepository: vi.fn(async () => ({ id: REPOSITORY_ID, projectId: PROJECT_ID, owner: "acme", name: "tool" })),
    attachRepository: vi.fn(async () => PROJECT_ID),
    refreshRepository: vi.fn(async () => undefined),
    markRepositoryRefreshError: vi.fn(async () => undefined),
    addRepositoryCandidates: vi.fn(async () => undefined),
    updateJobProgress: vi.fn(async () => undefined),
  };
}

function createDependencies(
  store: IngestionStore,
  overrides: Partial<TaskImplementationDependencies> = {},
): TaskImplementationDependencies {
  return {
    store,
    youtube: {
      resolveChannel: vi.fn(async () => channel),
      getChannelById: vi.fn(async () => channel),
      getVideo: vi.fn(async () => video as YouTubeVideo | undefined),
      getVideos: vi.fn(async (ids: string[]) => ids.map((id) => ({ ...video, id }))),
      listUploadsPage: vi.fn(async (): Promise<YouTubeUploadsPage> => ({ items: [] })),
    },
    github: {
      getRepository: vi.fn(async () => repository),
      searchRepositories: vi.fn(async () => [repository]),
    },
    enqueue: vi.fn(async () => true),
    ...overrides,
  };
}

describe("task implementation factory", () => {
  it("resolves a durable channel import and queues Daily latest-25 backfill", async () => {
    const store = createStore();
    const dependencies = createDependencies(store);
    const tasks = createTaskImplementations(dependencies);

    await tasks.channel_resolve!({
      jobId: JOB_ID,
      correlationId: CORRELATION_ID,
      url: "https://www.youtube.com/@channel",
      requestedByUserId: "77777777-7777-4777-8777-777777777777",
    }, helpers);

    expect(dependencies.youtube.resolveChannel).toHaveBeenCalledWith(
      "https://www.youtube.com/@channel",
    );
    expect(store.ensureChannelSubscription).toHaveBeenCalledWith(channel, {
      subscriptionJobId: JOB_ID,
      requestedByUserId: "77777777-7777-4777-8777-777777777777",
    });
    expect(dependencies.enqueue).toHaveBeenCalledWith(
      "channel_backfill",
      expect.objectContaining({
        scopeType: "channel",
        scopeId: CHANNEL_ID,
        queueName: `channel:${CHANNEL_ID}`,
        payload: {
          channelSourceId: CHANNEL_ID,
          historyMode: "latest_25",
          subscriptionJobId: JOB_ID,
        },
      }),
      expect.stringMatching(/^v1:/u),
    );
    expect(store.confirmChannelSubscriptionBackfill).toHaveBeenCalledWith(
      CHANNEL_ID,
      JOB_ID,
      JOB_ID,
    );
    expect(store.updateJobProgress).toHaveBeenCalledWith(JOB_ID, 1, 1);
  });

  it("backfills every uploads page and enqueues each video independently", async () => {
    const store = createStore();
    const listUploadsPage = vi.fn()
      .mockResolvedValueOnce({ items: [{ videoId: "KITOm0HitpY", title: "One" }], nextPageToken: "next" })
      .mockResolvedValueOnce({ items: [{ videoId: "dQw4w9WgXcQ", title: "Two" }] });
    const dependencies = createDependencies(store);
    dependencies.youtube.listUploadsPage = listUploadsPage;
    const tasks = createTaskImplementations(dependencies);

    await tasks.channel_backfill!({ jobId: JOB_ID, correlationId: CORRELATION_ID, channelSourceId: CHANNEL_ID }, helpers);

    expect(listUploadsPage).toHaveBeenNthCalledWith(1, channel.uploadsPlaylistId, undefined);
    expect(listUploadsPage).toHaveBeenNthCalledWith(2, channel.uploadsPlaylistId, "next");
    expect(dependencies.youtube.getVideos).toHaveBeenNthCalledWith(1, ["KITOm0HitpY"]);
    expect(dependencies.youtube.getVideos).toHaveBeenNthCalledWith(2, ["dQw4w9WgXcQ"]);
    expect(store.upsertDiscoveredVideo).toHaveBeenCalledTimes(2);
    expect(store.upsertVideo).toHaveBeenCalledTimes(2);
    expect(dependencies.enqueue).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(dependencies.enqueue).mock.calls) {
      expect(call[0]).toBe("video_ingest");
      expect(call[1]).toEqual(expect.objectContaining({
        payload: expect.objectContaining({
          parentJobId: JOB_ID,
          useStoredMetadata: true,
        }),
      }));
    }
    expect(store.completeChannelSync).toHaveBeenCalledWith(
      CHANNEL_ID,
      expect.objectContaining({ lastSeenVideoId: "KITOm0HitpY" }),
      JOB_ID,
    );
    expect(store.updateJobProgress).toHaveBeenLastCalledWith(JOB_ID, 0, 2);
  });

  it("honors a bounded latest-history policy during the initial backfill", async () => {
    const store = createStore();
    const uploads = Array.from({ length: 20 }, (_, index) => ({
      videoId: `video${String(index).padStart(6, "0")}`,
      title: `Video ${index}`,
      publishedAt: "2026-07-01T00:00:00.000Z",
    }));
    const dependencies = createDependencies(store);
    dependencies.youtube.listUploadsPage = vi.fn(async () => ({ items: uploads }));
    const tasks = createTaskImplementations(dependencies);

    await tasks.channel_backfill!({
      jobId: JOB_ID,
      correlationId: CORRELATION_ID,
      channelSourceId: CHANNEL_ID,
      historyMode: "latest_10",
    }, helpers);

    expect(store.upsertDiscoveredVideo).toHaveBeenCalledTimes(10);
    expect(dependencies.enqueue).toHaveBeenCalledTimes(10);
  });

  it("fails safely without advancing a checkpoint when the bounded page limit is exceeded", async () => {
    const store = createStore();
    const dependencies = createDependencies(store, { maximumChannelPages: 2 });
    dependencies.youtube.listUploadsPage = vi.fn(async () => ({ items: [], nextPageToken: crypto.randomUUID() }));
    const tasks = createTaskImplementations(dependencies);

    await expect(tasks.channel_backfill!({ jobId: JOB_ID, correlationId: CORRELATION_ID, channelSourceId: CHANNEL_ID }, helpers))
      .rejects.toMatchObject({ code: "YOUTUBE_PAGE_LIMIT_EXCEEDED", retryable: true });
    expect(dependencies.youtube.listUploadsPage).toHaveBeenCalledTimes(2);
    expect(store.completeChannelSync).not.toHaveBeenCalled();
    expect(store.markChannelError).toHaveBeenCalledWith(
      CHANNEL_ID,
      "YOUTUBE_PAGE_LIMIT_EXCEEDED",
      expect.stringContaining("bounded page limit"),
    );
  });

  it("ingests official video data, parses the description, and queues exact repository resolution", async () => {
    const store = createStore();
    vi.mocked(store.ingestParsedVideo).mockResolvedValue({
      repositoryTargets: [{ projectId: PROJECT_ID, url: repository.canonicalUrl }],
      websiteTargets: [{ projectId: PROJECT_ID, url: "https://tool.example" }],
    });
    const dependencies = createDependencies(store);
    const tasks = createTaskImplementations(dependencies);

    await tasks.video_ingest!({ jobId: JOB_ID, correlationId: CORRELATION_ID, url: "https://youtu.be/KITOm0HitpY" }, helpers);

    expect(store.upsertChannel).toHaveBeenCalledWith(channel, {
      monitoringEnabled: false,
    });
    expect(store.ingestParsedVideo).toHaveBeenCalledWith(
      expect.objectContaining({ id: VIDEO_ID }),
      [expect.objectContaining({ name: "Acme Tool", timestampSeconds: 0 })],
      "youtube-description/v1",
      false,
      CORRELATION_ID,
    );
    expect(store.recordSourceReview).toHaveBeenCalledWith(
      VIDEO_ID,
      JOB_ID,
      expect.objectContaining({ parserVersion: "youtube-description/v1" }),
    );
    expect(dependencies.enqueue).toHaveBeenCalledWith(
      "repository_resolve",
      expect.objectContaining({ payload: expect.objectContaining({
        projectId: PROJECT_ID,
        repositoryUrl: repository.canonicalUrl,
        parentJobId: JOB_ID,
      }) }),
      expect.stringMatching(/^v1:/u),
    );
    expect(dependencies.enqueue).toHaveBeenCalledWith(
      "website_metadata",
      expect.objectContaining({ payload: expect.objectContaining({
        projectId: PROJECT_ID,
        url: "https://tool.example",
        parentJobId: JOB_ID,
      }) }),
      expect.stringMatching(/^v1:/u),
    );
  });

  it("does not re-resolve or enable a channel for an already-discovered monitored video", async () => {
    const store = createStore();
    const dependencies = createDependencies(store);
    const tasks = createTaskImplementations(dependencies);

    await tasks.video_ingest!({
      jobId: JOB_ID,
      correlationId: CORRELATION_ID,
      videoSourceId: VIDEO_ID,
    }, helpers);

    expect(dependencies.youtube.getChannelById).not.toHaveBeenCalled();
    expect(store.upsertChannel).not.toHaveBeenCalled();
    expect(store.upsertVideo).toHaveBeenCalledWith(CHANNEL_ID, video);
  });

  it("parses metadata already fetched in the channel batch without a second YouTube request", async () => {
    const store = createStore();
    const dependencies = createDependencies(store);
    const tasks = createTaskImplementations(dependencies);

    await tasks.video_ingest!({
      jobId: JOB_ID,
      correlationId: CORRELATION_ID,
      videoSourceId: VIDEO_ID,
      useStoredMetadata: true,
    }, helpers);

    expect(dependencies.youtube.getVideo).not.toHaveBeenCalled();
    expect(dependencies.youtube.getChannelById).not.toHaveBeenCalled();
    expect(store.upsertVideo).not.toHaveBeenCalled();
    expect(store.ingestParsedVideo).toHaveBeenCalledWith(
      expect.objectContaining({ id: VIDEO_ID }),
      expect.any(Array),
      "youtube-description/v1",
      false,
      CORRELATION_ID,
    );
  });

  it("marks a playlist item missing from the batch response without another YouTube request", async () => {
    const store = createStore();
    const dependencies = createDependencies(store);
    const tasks = createTaskImplementations(dependencies);

    await tasks.video_ingest!({
      jobId: JOB_ID,
      correlationId: CORRELATION_ID,
      videoSourceId: VIDEO_ID,
      sourceUnavailable: true,
    }, helpers);

    expect(dependencies.youtube.getVideo).not.toHaveBeenCalled();
    expect(store.markVideoUnavailable).toHaveBeenCalledWith(VIDEO_ID, CORRELATION_ID);
    expect(store.ingestParsedVideo).not.toHaveBeenCalled();
  });

  it("purges an existing video's restricted source fields when official revalidation returns no item", async () => {
    const store = createStore();
    const dependencies = createDependencies(store);
    dependencies.youtube.getVideo = vi.fn(async () => undefined);
    const tasks = createTaskImplementations(dependencies);

    await tasks.youtube_revalidate!({ jobId: JOB_ID, correlationId: CORRELATION_ID, videoSourceId: VIDEO_ID }, helpers);

    expect(store.markVideoUnavailable).toHaveBeenCalledWith(VIDEO_ID, CORRELATION_ID);
    expect(store.ingestParsedVideo).not.toHaveBeenCalled();
    expect(store.updateJobProgress).toHaveBeenCalledWith(JOB_ID, 1, 1);
  });

  it("keeps GitHub search results pending and never auto-attaches them", async () => {
    const store = createStore();
    const dependencies = createDependencies(store);
    const tasks = createTaskImplementations(dependencies);

    await tasks.repository_resolve!({
      jobId: JOB_ID,
      correlationId: CORRELATION_ID,
      projectId: PROJECT_ID,
      query: "Acme Tool",
    }, helpers);

    expect(store.addRepositoryCandidates).toHaveBeenCalledWith([
      expect.objectContaining({ projectId: PROJECT_ID, repository, discoveryMethod: "github_search" }),
    ]);
    expect(store.attachRepository).not.toHaveBeenCalled();
  });

  it("records a safe repository refresh error while preserving stored metadata", async () => {
    const store = createStore();
    const dependencies = createDependencies(store);
    dependencies.github.getRepository = vi.fn(async () => {
      throw new IntegrationError({
        provider: "github",
        code: "GITHUB_RATE_LIMITED",
        message: "GitHub API rate limit is temporarily exhausted.",
        retryable: true,
      });
    });
    const tasks = createTaskImplementations(dependencies);

    await expect(tasks.repository_refresh!({
      jobId: JOB_ID,
      correlationId: CORRELATION_ID,
      repositoryId: REPOSITORY_ID,
    }, helpers)).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED", retryable: true });
    expect(store.markRepositoryRefreshError).toHaveBeenCalledWith(
      REPOSITORY_ID,
      "GitHub API rate limit is temporarily exhausted.",
    );
    expect(store.refreshRepository).not.toHaveBeenCalled();
  });

  it("turns multiple website repository links into review candidates", async () => {
    const store = createStore();
    const metadata: WebsiteMetadata = {
      requestedUrl: "https://tool.example/",
      finalUrl: "https://tool.example/",
      status: 200,
      contentType: "text/html",
      redirectCount: 0,
      title: "Tool",
      openGraph: {},
      githubRepositories: [
        { repoKey: "acme/tool", url: "https://github.com/acme/tool" },
        { repoKey: "acme/other", url: "https://github.com/acme/other" },
      ],
    };
    const dependencies = createDependencies(store, { fetchWebsite: vi.fn(async () => metadata) });
    const tasks = createTaskImplementations(dependencies);
    await tasks.website_metadata!({ jobId: JOB_ID, correlationId: CORRELATION_ID, url: "https://tool.example/" }, helpers);

    expect(dependencies.enqueue).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(dependencies.enqueue).mock.calls) {
      expect(call[1].payload).toMatchObject({
        projectId: PROJECT_ID,
        candidateOnly: true,
        discoveryMethod: "website_ambiguous",
        parentJobId: JOB_ID,
      });
    }
  });
});
