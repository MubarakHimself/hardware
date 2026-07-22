import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../../db/index", () => ({
  getPool: () => ({
    query: () => {
      throw new Error("Unexpected database query");
    },
  }),
}));

import {
  emptyDatabaseMetricsSnapshot,
  getSearchMetricsSnapshot,
  measureSearchOperation,
  renderPrometheusMetrics,
  resetSearchMetricsForTests,
} from "../../lib/observability/metrics";
import {
  collectDatabaseMetrics,
  requireMetricsAuthorization,
} from "../../lib/server/metrics";
import { ApiError } from "../../lib/server/errors";
import { ServerConfigurationError } from "../../lib/server/config";

describe("Prometheus metrics", () => {
  beforeEach(() => resetSearchMetricsForTests());

  it("records successful and failed search latency without losing in-flight state", async () => {
    await measureSearchOperation(async () => "ok");
    await expect(
      measureSearchOperation(async () => {
        throw new Error("search failed");
      }),
    ).rejects.toThrow("search failed");

    const snapshot = getSearchMetricsSnapshot();
    expect(snapshot.count).toBe(2);
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.sum).toBeGreaterThanOrEqual(0);
    expect(snapshot.bucketCounts.at(-1)).toBe(2);
  });

  it("renders Prometheus text with stable aggregates and escaped bounded labels", () => {
    const body = renderPrometheusMetrics({
      ...emptyDatabaseMetricsSnapshot(),
      activeWorkerHeartbeats: 1,
      queueDepth: [
        { type: "video_ingest", state: "queued", count: 4 },
      ],
      jobFailures: [
        { type: "video_ingest", code: 'SAFE"\\\nCODE', count: 2 },
      ],
      providerErrors: [
        { category: "quota", code: "YOUTUBE_RATE_LIMITED", count: 3 },
      ],
      channels: [
        {
          channelId: "channel-1",
          syncAgeSeconds: null,
          lastSuccessUnixSeconds: null,
        },
      ],
    });

    expect(body).toContain(
      'hardware_ingestion_queue_depth{state="queued",type="all"} 4',
    );
    expect(body).toContain(
      'hardware_ingestion_provider_errors_total{category="quota",code="all"} 3',
    );
    expect(body).toContain('code="SAFE\\"\\\\\\nCODE"');
    expect(body).toContain(
      'hardware_channel_sync_age_seconds{channel_id="channel-1"} +Inf',
    );
    expect(body).toMatch(
      /hardware_search_request_duration_seconds_bucket\{le="\+Inf"\} 0/,
    );
    expect(body.endsWith("\n")).toBe(true);
  });

  it("accepts only a constant-format bearer credential for the operational secret", () => {
    const secret = "unit-test-health-token-7f3c9a2b5d8e1f4a";
    expect(() =>
      requireMetricsAuthorization(
        new Request("https://hardware.example/api/metrics", {
          headers: { authorization: `Bearer ${secret}` },
        }),
        secret,
      ),
    ).not.toThrow();
    expect(() =>
      requireMetricsAuthorization(
        new Request("https://hardware.example/api/metrics", {
          headers: { "x-healthcheck-token": secret },
        }),
        secret,
      ),
    ).toThrowError(ApiError);
    expect(() =>
      requireMetricsAuthorization(
        new Request("https://hardware.example/api/metrics"),
        secret,
      ),
    ).toThrowError(ApiError);
    expect(() =>
      requireMetricsAuthorization(
        new Request("https://hardware.example/api/metrics"),
        "short",
      ),
    ).toThrowError(ServerConfigurationError);
  });

  it("derives queue, duration, failure, provider, heartbeat, and channel metrics from SQL", async () => {
    const resultSets = [
      [{ type: "video_ingest", state: "queued", count: "2" }],
      [
        {
          type: "video_ingest",
          state: "succeeded",
          count: "1",
          sum_seconds: 4.5,
          p95_seconds: 4.5,
        },
      ],
      [{ type: "video_ingest", code: "YOUTUBE_RATE_LIMITED", count: "3" }],
      [{ category: "quota", code: "YOUTUBE_RATE_LIMITED", count: "3" }],
      [{ active_workers: 1, heartbeat_age_seconds: 12.5 }],
      [
        {
          channel_id: "channel-1",
          sync_age_seconds: 60,
          last_success_unix_seconds: 1_785_000_000,
        },
      ],
    ];
    const query = vi.fn(async (text: string) => {
      expect(text.trim()).not.toBe("");
      return { rows: resultSets.shift() ?? [] };
    });

    const snapshot = await collectDatabaseMetrics({ query });

    expect(query).toHaveBeenCalledTimes(6);
    const sql = query.mock.calls.map(([text]) => text).join("\n");
    expect(sql).toContain(
      "(count(*) filter (\n                 where last_seen_at >= now() - interval '60 seconds'\n               ))::int as active_workers",
    );
    expect(sql).toContain(
      "e.code in ('YOUTUBE_RATE_LIMITED', 'GITHUB_RATE_LIMITED')",
    );
    expect(sql).toContain("e.code like 'WEBSITE\\_%' escape '\\'");
    expect(snapshot).toMatchObject({
      queueDepth: [{ type: "video_ingest", state: "queued", count: 2 }],
      jobDurations: [
        {
          type: "video_ingest",
          state: "succeeded",
          count: 1,
          sumSeconds: 4.5,
          p95Seconds: 4.5,
        },
      ],
      activeWorkerHeartbeats: 1,
      workerHeartbeatAgeSeconds: 12.5,
      channels: [
        {
          channelId: "channel-1",
          syncAgeSeconds: 60,
          lastSuccessUnixSeconds: 1_785_000_000,
        },
      ],
    });
  });
});
