import type { ParsedProjectMention, WebsiteMetadata } from "../../lib/ingestion";
import type {
  GitHubRepositoryMetadata,
  YouTubeChannel,
  YouTubeUpload,
  YouTubeVideo,
} from "../../lib/integrations";
import type { TaskName } from "../jobs";

export interface StoredChannel {
  id: string;
  youtubeChannelId: string;
  uploadsPlaylistId: string;
  checkpoint: Record<string, unknown>;
}

export interface StoredVideo {
  id: string;
  channelId: string;
  youtubeVideoId: string;
}

export interface StoredRepository {
  id: string;
  projectId: string;
  owner: string;
  name: string;
}

export interface MetadataTarget {
  projectId: string;
  url: string;
}

export interface ParsedVideoTargets {
  repositoryTargets: MetadataTarget[];
  websiteTargets: MetadataTarget[];
}

export interface CandidateInput {
  projectId: string;
  repository: GitHubRepositoryMetadata;
  discoveryMethod: string;
  evidence: Record<string, unknown>;
  scoreBasisPoints: number;
}

export interface IngestionStore {
  getChannel(id: string): Promise<StoredChannel | undefined>;
  upsertChannel(channel: YouTubeChannel): Promise<StoredChannel>;
  upsertDiscoveredVideo(channelId: string, upload: YouTubeUpload): Promise<StoredVideo>;
  completeChannelSync(channelId: string, checkpoint: Record<string, unknown>): Promise<void>;
  markChannelError(channelId: string, code: string, summary: string): Promise<void>;
  getVideo(id: string): Promise<StoredVideo | undefined>;
  upsertVideo(channelId: string, video: YouTubeVideo): Promise<StoredVideo>;
  markVideoUnavailable(videoId: string, correlationId: string): Promise<void>;
  ingestParsedVideo(
    video: StoredVideo,
    mentions: ParsedProjectMention[],
    parserVersion: string,
    purgeMissingRawSegments: boolean,
    correlationId: string,
  ): Promise<ParsedVideoTargets>;
  ensureWebsiteProject(projectId: string | undefined, url: string, title?: string): Promise<string>;
  applyWebsiteMetadata(projectId: string, metadata: WebsiteMetadata): Promise<void>;
  getRepository(id: string): Promise<StoredRepository | undefined>;
  attachRepository(projectId: string | undefined, repository: GitHubRepositoryMetadata): Promise<string>;
  refreshRepository(repositoryId: string, repository: GitHubRepositoryMetadata): Promise<void>;
  markRepositoryRefreshError(repositoryId: string, summary: string): Promise<void>;
  addRepositoryCandidates(candidates: CandidateInput[]): Promise<void>;
  updateJobProgress(jobId: string, completedItems: number, totalItems: number, warningCount?: number): Promise<void>;
}

export type EnqueueChildJob = (
  task: TaskName,
  scope: {
    scopeType: string;
    scopeId: string;
    payload: Record<string, unknown>;
    queueName?: string;
  },
  scheduleBucket: string,
) => Promise<boolean>;
