import { z } from "zod";
import { getPool } from "../../db/index";
import { GitHubClient, YouTubeClient } from "../../lib/integrations";
import { enqueueTrackedJob } from "../scheduler";
import type { TaskImplementations } from "../tasks";
import { createTaskImplementations } from "./index";
import { PgIngestionStore } from "./pg-store";

const integrationEnvironmentSchema = z.object({
  YOUTUBE_API_KEY: z.string().trim().min(20),
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

/** Parse credentials at worker startup so enabled source handlers fail closed. */
export function createRuntimeTaskImplementations(): TaskImplementations {
  const env = parseIntegrationEnvironment();
  return createTaskImplementations({
    store: new PgIngestionStore(getPool()),
    youtube: new YouTubeClient({ apiKey: env.YOUTUBE_API_KEY, timeoutMs: env.SOURCE_HTTP_TIMEOUT_MS }),
    github: new GitHubClient({ token: env.GITHUB_TOKEN, timeoutMs: env.SOURCE_HTTP_TIMEOUT_MS }),
    enqueue: enqueueTrackedJob,
  });
}
