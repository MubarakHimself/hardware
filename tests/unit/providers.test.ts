import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runtime = vi.hoisted(() => ({
  config: {
    mode: "local" as const,
    youtubeApiKey: undefined as string | undefined,
    githubToken: undefined as string | undefined,
  },
}));

vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => runtime.config,
}));

import type { PoolClient } from "pg";
import { addTrackedGraphileJob } from "../../lib/server/job-queue";
import { queueImportWithClient } from "../../lib/server/imports";
import {
  listProviderStatuses,
  requireImportProviderConfigured,
  requireTaskProviderConfigured,
} from "../../lib/server/providers";

const actor = {
  userId: "00000000-0000-4000-8000-000000000001",
  role: "admin" as const,
};

beforeEach(() => {
  runtime.config.youtubeApiKey = undefined;
  runtime.config.githubToken = undefined;
});

describe("optional desktop providers", () => {
  it("returns only redacted provider readiness", () => {
    expect(listProviderStatuses()).toEqual([
      expect.objectContaining({
        provider: "youtube",
        configured: false,
        verification: "not_configured",
      }),
      expect.objectContaining({
        provider: "github",
        configured: false,
        verification: "not_configured",
      }),
    ]);
    expect(JSON.stringify(listProviderStatuses())).not.toMatch(
      /apiKey|token|credentialValue/iu,
    );
  });

  it("uses the stable provider_not_configured problem for YouTube work", () => {
    for (const action of [
      () => requireImportProviderConfigured("youtube_video"),
      () => requireImportProviderConfigured("youtube_channel"),
      () => requireTaskProviderConfigured("channel_poll"),
      () => requireTaskProviderConfigured("youtube_revalidate"),
    ]) {
      expect(action).toThrow(
        expect.objectContaining({
          code: "provider_not_configured",
          status: 409,
        }),
      );
    }
    expect(() => requireImportProviderConfigured("website")).not.toThrow();
    expect(() =>
      requireTaskProviderConfigured("repository_refresh"),
    ).not.toThrow();
  });

  it("rejects direct YouTube imports before any database query", async () => {
    const query = vi.fn();
    const client = { query } as unknown as PoolClient;

    await expect(
      queueImportWithClient(client, {
        actor,
        input: {
          kind: "youtube_video",
          url: "https://www.youtube.com/watch?v=KITOm0HitpY",
        },
        correlationId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toMatchObject({
      code: "provider_not_configured",
      status: 409,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("does not call Graphile for a provider-dependent job without a key", async () => {
    const query = vi.fn();
    const client = { query } as unknown as PoolClient;

    await expect(
      addTrackedGraphileJob(client, {
        task: "video_ingest",
        jobId: "11111111-1111-4111-8111-111111111111",
        correlationId: "22222222-2222-4222-8222-222222222222",
        jobKey: "hardware:test",
      }),
    ).rejects.toMatchObject({
      code: "provider_not_configured",
      status: 409,
    });
    expect(query).not.toHaveBeenCalled();
  });
});
