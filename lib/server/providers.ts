import "server-only";
import type {
  DesktopProvider,
  ProviderStatus,
} from "../desktop/contracts";
import type { ImportKind, IngestionJobType } from "../domain";
import { getServerConfig } from "./config";
import { ApiError } from "./errors";

const youtubeTasks = new Set<IngestionJobType>([
  "channel_resolve",
  "channel_backfill",
  "channel_poll",
  "video_ingest",
  "youtube_revalidate",
]);

export function providerForTask(
  task: IngestionJobType,
): DesktopProvider | null {
  return youtubeTasks.has(task) ? "youtube" : null;
}

export function providerForImport(kind: ImportKind): DesktopProvider | null {
  return kind === "youtube_video" || kind === "youtube_channel"
    ? "youtube"
    : null;
}

export function isProviderConfigured(provider: DesktopProvider): boolean {
  const config = getServerConfig();
  if (config.mode === "demo") return true;
  if (provider === "youtube") return Boolean(config.youtubeApiKey);
  return Boolean(config.githubToken);
}

export function providerNotConfigured(
  provider: DesktopProvider,
): ApiError {
  const label = provider === "youtube" ? "YouTube" : "GitHub";
  return new ApiError({
    status: 409,
    code: "provider_not_configured",
    title: "Provider not configured",
    detail: `${label} credentials must be configured in Settings before this action can be queued.`,
  });
}

export function requireProviderConfigured(
  provider: DesktopProvider,
): void {
  if (!isProviderConfigured(provider)) {
    throw providerNotConfigured(provider);
  }
}

export function requireTaskProviderConfigured(
  task: IngestionJobType,
): void {
  const provider = providerForTask(task);
  if (provider) requireProviderConfigured(provider);
}

export function requireImportProviderConfigured(kind: ImportKind): void {
  const provider = providerForImport(kind);
  if (provider) requireProviderConfigured(provider);
}

export function listProviderStatuses(): ProviderStatus[] {
  const config = getServerConfig();
  const demo = config.mode === "demo";
  const youtubeConfigured = demo || Boolean(config.youtubeApiKey);
  const githubConfigured = demo || Boolean(config.githubToken);

  return [
    {
      provider: "youtube",
      label: "YouTube Data API",
      configured: youtubeConfigured,
      required: false,
      verification: youtubeConfigured ? "unverified" : "not_configured",
      detail: youtubeConfigured
        ? "A credential is available to the current runtime."
        : "Add a YouTube API key to import videos and synchronize channels.",
      lastValidatedAt: null,
    },
    {
      provider: "github",
      label: "GitHub",
      configured: githubConfigured,
      required: false,
      verification: githubConfigured ? "unverified" : "not_configured",
      detail: githubConfigured
        ? "A token is available to raise GitHub API limits."
        : "Optional. Public repository metadata still works at anonymous API limits.",
      lastValidatedAt: null,
    },
  ];
}
