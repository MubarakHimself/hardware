import { IntegrationError, requestJson } from "./http";

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/u;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const MAX_PAGE_SIZE = 50;

interface YouTubeErrorBody {
  error?: { errors?: Array<{ reason?: string }>; message?: string };
}

interface ThumbnailSet {
  default?: { url?: string };
  medium?: { url?: string };
  high?: { url?: string };
}

interface ChannelListBody extends YouTubeErrorBody {
  items?: Array<{
    id?: string;
    snippet?: { title?: string; customUrl?: string; thumbnails?: ThumbnailSet };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }>;
}

interface PlaylistItemsBody extends YouTubeErrorBody {
  nextPageToken?: string;
  items?: Array<{
    contentDetails?: { videoId?: string; videoPublishedAt?: string };
    snippet?: {
      title?: string;
      publishedAt?: string;
      resourceId?: { videoId?: string };
    };
  }>;
}

interface VideosBody extends YouTubeErrorBody {
  items?: Array<{
    id?: string;
    etag?: string;
    snippet?: {
      channelId?: string;
      title?: string;
      description?: string;
      publishedAt?: string;
    };
    contentDetails?: { duration?: string };
  }>;
}

export interface YouTubeChannel {
  id: string;
  uploadsPlaylistId: string;
  handle?: string;
  title: string;
  canonicalUrl: string;
  thumbnailUrl?: string;
}

export interface YouTubeUpload {
  videoId: string;
  title?: string;
  publishedAt?: string;
}

export interface YouTubeUploadsPage {
  items: YouTubeUpload[];
  nextPageToken?: string;
}

export interface YouTubeVideo {
  id: string;
  channelId: string;
  title: string;
  description: string;
  etag?: string;
  publishedAt?: string;
  durationSeconds?: number;
}

export interface YouTubeClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

export type YouTubeChannelReference =
  | { kind: "id"; value: string }
  | { kind: "handle"; value: string };

export function parseYouTubeChannelReference(input: string): YouTubeChannelReference {
  const source = input.trim();
  if (CHANNEL_ID_PATTERN.test(source)) return { kind: "id", value: source };
  if (/^@[A-Za-z0-9._-]{3,30}$/u.test(source)) {
    return { kind: "handle", value: source.slice(1) };
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new IntegrationError({
      provider: "youtube",
      code: "YOUTUBE_INVALID_CHANNEL_REFERENCE",
      message: "Use a YouTube channel ID, @handle, or channel URL.",
      retryable: false,
    });
  }
  const host = url.hostname.toLowerCase();
  if (!(host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com")) {
    throw new IntegrationError({
      provider: "youtube",
      code: "YOUTUBE_INVALID_CHANNEL_REFERENCE",
      message: "The channel URL must be hosted by YouTube.",
      retryable: false,
    });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "channel" && parts[1] && CHANNEL_ID_PATTERN.test(parts[1])) {
    return { kind: "id", value: parts[1] };
  }
  if (parts[0]?.startsWith("@") && /^@[A-Za-z0-9._-]{3,30}$/u.test(parts[0])) {
    return { kind: "handle", value: parts[0].slice(1) };
  }
  throw new IntegrationError({
    provider: "youtube",
    code: "YOUTUBE_INVALID_CHANNEL_REFERENCE",
    message: "Use a YouTube /channel/ID URL or an @handle URL.",
    retryable: false,
  });
}

export function parseYouTubeVideoId(input: string): string {
  const source = input.trim();
  if (VIDEO_ID_PATTERN.test(source)) return source;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new IntegrationError({ provider: "youtube", code: "YOUTUBE_INVALID_VIDEO_REFERENCE", message: "Use a valid YouTube video URL or ID.", retryable: false });
  }
  const host = url.hostname.toLowerCase();
  let candidate: string | undefined;
  if (host === "youtu.be") candidate = url.pathname.split("/").filter(Boolean)[0];
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const parts = url.pathname.split("/").filter(Boolean);
    candidate = url.pathname === "/watch" ? url.searchParams.get("v") ?? undefined :
      (["shorts", "embed", "live"].includes(parts[0] ?? "") ? parts[1] : undefined);
  }
  if (!candidate || !VIDEO_ID_PATTERN.test(candidate)) {
    throw new IntegrationError({ provider: "youtube", code: "YOUTUBE_INVALID_VIDEO_REFERENCE", message: "Use a valid YouTube video URL or ID.", retryable: false });
  }
  return candidate;
}

/** Strict ISO-8601 duration subset emitted by YouTube contentDetails. */
export function parseYouTubeDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u.exec(value);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
}

function youtubeError(status: number, body: YouTubeErrorBody, retryAfter: string | null): IntegrationError {
  const reasons = body.error?.errors?.map((entry) => entry.reason ?? "") ?? [];
  const quota = reasons.some((reason) => ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"].includes(reason));
  const retryable = quota || status === 429 || status >= 500;
  const code = quota || status === 429 ? "YOUTUBE_RATE_LIMITED" : status === 401 || status === 403 ? "YOUTUBE_CREDENTIALS_REJECTED" : status === 404 ? "YOUTUBE_NOT_FOUND" : status >= 500 ? "YOUTUBE_UPSTREAM_ERROR" : "YOUTUBE_REQUEST_REJECTED";
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
  return new IntegrationError({
    provider: "youtube",
    code,
    message: quota ? "YouTube API quota is temporarily unavailable." : status === 404 ? "The requested YouTube resource does not exist." : "YouTube rejected the API request.",
    retryable,
    status,
    retryAfterMs: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : undefined,
  });
}

export class YouTubeClient {
  private readonly apiKey: string;
  private readonly baseUrl: URL;
  private readonly fetchImplementation?: typeof fetch;
  private readonly timeoutMs?: number;

  constructor(options: YouTubeClientOptions) {
    if (!options.apiKey.trim()) throw new Error("YouTube API key is required.");
    this.apiKey = options.apiKey;
    this.baseUrl = new URL(options.baseUrl ?? "https://www.googleapis.com/youtube/v3/");
    this.fetchImplementation = options.fetchImplementation;
    this.timeoutMs = options.timeoutMs;
  }

  private async request<T extends YouTubeErrorBody>(path: string, parameters: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    url.searchParams.set("key", this.apiKey);
    const response = await requestJson<T>("youtube", url, { fetchImplementation: this.fetchImplementation, timeoutMs: this.timeoutMs });
    if (response.status < 200 || response.status >= 300) throw youtubeError(response.status, response.data, response.headers.get("retry-after"));
    return response.data;
  }

  async resolveChannel(input: string): Promise<YouTubeChannel> {
    const reference = parseYouTubeChannelReference(input);
    const parameters: Record<string, string> = { part: "snippet,contentDetails", maxResults: "2" };
    parameters[reference.kind === "id" ? "id" : "forHandle"] = reference.value;
    const data = await this.request<ChannelListBody>("channels", parameters);
    const items = data.items ?? [];
    if (items.length === 0) throw new IntegrationError({ provider: "youtube", code: "YOUTUBE_CHANNEL_NOT_FOUND", message: "No public YouTube channel matched that reference.", retryable: false });
    if (items.length > 1) throw new IntegrationError({ provider: "youtube", code: "YOUTUBE_CHANNEL_AMBIGUOUS", message: "The YouTube channel reference was ambiguous.", retryable: false });
    return this.mapChannel(items[0]);
  }

  async getChannelById(id: string): Promise<YouTubeChannel> {
    if (!CHANNEL_ID_PATTERN.test(id)) throw new IntegrationError({ provider: "youtube", code: "YOUTUBE_INVALID_CHANNEL_REFERENCE", message: "The YouTube channel ID is invalid.", retryable: false });
    const data = await this.request<ChannelListBody>("channels", { part: "snippet,contentDetails", id, maxResults: "1" });
    if ((data.items ?? []).length === 0) throw new IntegrationError({ provider: "youtube", code: "YOUTUBE_CHANNEL_NOT_FOUND", message: "The YouTube channel is unavailable.", retryable: false });
    return this.mapChannel(data.items![0]);
  }

  private mapChannel(item: NonNullable<ChannelListBody["items"]>[number]): YouTubeChannel {
    const id = item.id;
    const title = item.snippet?.title;
    const uploadsPlaylistId = item.contentDetails?.relatedPlaylists?.uploads;
    if (!id || !title || !uploadsPlaylistId) throw new IntegrationError({ provider: "youtube", code: "YOUTUBE_INVALID_RESPONSE", message: "YouTube returned incomplete channel data.", retryable: true });
    const customUrl = item.snippet?.customUrl;
    return {
      id,
      title,
      uploadsPlaylistId,
      handle: customUrl?.startsWith("@") ? customUrl : undefined,
      canonicalUrl: `https://www.youtube.com/channel/${id}`,
      thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url,
    };
  }

  async listUploadsPage(playlistId: string, pageToken?: string): Promise<YouTubeUploadsPage> {
    const parameters: Record<string, string> = { part: "snippet,contentDetails", playlistId, maxResults: String(MAX_PAGE_SIZE) };
    if (pageToken) parameters.pageToken = pageToken;
    const data = await this.request<PlaylistItemsBody>("playlistItems", parameters);
    const items = (data.items ?? []).flatMap((item): YouTubeUpload[] => {
      const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
      if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) return [];
      return [{ videoId, title: item.snippet?.title, publishedAt: item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt }];
    });
    return { items, nextPageToken: data.nextPageToken };
  }

  async getVideos(ids: string[]): Promise<YouTubeVideo[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    if (uniqueIds.length > MAX_PAGE_SIZE || uniqueIds.some((id) => !VIDEO_ID_PATTERN.test(id))) {
      throw new IntegrationError({ provider: "youtube", code: "YOUTUBE_INVALID_VIDEO_REFERENCE", message: "YouTube video IDs must be requested in valid batches of 50 or fewer.", retryable: false });
    }
    const data = await this.request<VideosBody>("videos", { part: "snippet,contentDetails,status", id: uniqueIds.join(","), maxResults: String(MAX_PAGE_SIZE) });
    return (data.items ?? []).flatMap((item): YouTubeVideo[] => {
      const id = item.id;
      const channelId = item.snippet?.channelId;
      const title = item.snippet?.title;
      if (!id || !channelId || title === undefined) return [];
      return [{ id, channelId, title, description: item.snippet?.description ?? "", etag: item.etag, publishedAt: item.snippet?.publishedAt, durationSeconds: parseYouTubeDuration(item.contentDetails?.duration) }];
    });
  }

  async getVideo(id: string): Promise<YouTubeVideo | undefined> {
    return (await this.getVideos([id]))[0];
  }
}

export function resolveYouTubeChannel(client: YouTubeClient, reference: string): Promise<YouTubeChannel> {
  return client.resolveChannel(reference);
}
