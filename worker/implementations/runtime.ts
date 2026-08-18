import { z } from "zod";
import { getPool } from "../../db/index";
import {
  GitHubClient,
  IntegrationError,
  YouTubeClient,
} from "../../lib/integrations";
import { enqueueTrackedJob } from "../scheduler";
import type { TaskImplementations } from "../tasks";
import {
  createTaskImplementations,
  type TaskImplementationDependencies,
} from "./index";
import { PgIngestionStore } from "./pg-store";

const integrationEnvironmentSchema = z.object({
  YOUTUBE_API_KEY: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(20).optional(),
  ),
  GITHUB_TOKEN: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(1).max(512).optional(),
  ),
  SOURCE_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(10_000).default(10_000),
});

export function parseIntegrationEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return integrationEnvironmentSchema.parse(environment);
}

function youtubeNotConfigured(): never {
  throw new IntegrationError({
    provider: "youtube",
    code: "YOUTUBE_PROVIDER_NOT_CONFIGURED",
    message: "Configure YouTube in Hardware Settings before running this job.",
    retryable: false,
  });
}

function disabledYouTubeClient(): TaskImplementationDependencies["youtube"] {
  return {
    resolveChannel: async () => youtubeNotConfigured(),
    getChannelById: async () => youtubeNotConfigured(),
    getVideo: async () => youtubeNotConfigured(),
    getVideos: async () => youtubeNotConfigured(),
    listUploadsPage: async () => youtubeNotConfigured(),
  };
}

/** Parse credentials at worker startup so enabled source handlers fail closed. */
export function createRuntimeTaskImplementations(): TaskImplementations {
  const env = parseIntegrationEnvironment();
  return createTaskImplementations({
    store: new PgIngestionStore(getPool()),
    youtube: env.YOUTUBE_API_KEY
      ? new YouTubeClient({
          apiKey: env.YOUTUBE_API_KEY,
          timeoutMs: env.SOURCE_HTTP_TIMEOUT_MS,
        })
      : disabledYouTubeClient(),
    github: new GitHubClient({ token: env.GITHUB_TOKEN, timeoutMs: env.SOURCE_HTTP_TIMEOUT_MS }),
    enqueue: enqueueTrackedJob,
  });
}
