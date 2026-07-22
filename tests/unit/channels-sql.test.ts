import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const databaseMock = vi.hoisted(() => {
  const queries: string[] = [];
  const query = vi.fn(async (text: string) => {
    queries.push(text);
    return {
      rows: [
        {
          id: "50000000-0000-4000-8000-000000000001",
          title: "Open Source Radar",
          handle: "@opensource",
          canonicalUrl: "https://www.youtube.com/@opensource",
          thumbnailUrl: null,
          status: "attention",
          videoCount: 20,
          projectCount: 18,
          totalItems: 20,
          completedItems: 20,
          warningCount: 1,
          failureCount: 2,
          progress: 100,
          lastSyncedAt: new Date("2026-07-22T00:00:00.000Z"),
          nextSyncAt: new Date("2026-07-22T06:00:00.000Z"),
          retryableJobId: "50000000-0000-4000-8000-000000000099",
        },
      ],
    };
  });
  return { queries, query };
});

vi.mock("../../db/index", () => ({
  getPool: () => ({ query: databaseMock.query }),
}));
vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => ({ mode: "production" }),
}));

import { listChannels } from "../../lib/server/channels";

describe("channel child-job observability", () => {
  it("derives terminal progress and retry state from children of the latest parent", async () => {
    await expect(listChannels()).resolves.toEqual([
      expect.objectContaining({
        status: "attention",
        progress: 100,
        progressLabel: "20 of 20 items",
        warningCount: 1,
        failureCount: 2,
        retryableJobId: "50000000-0000-4000-8000-000000000099",
      }),
    ]);

    const sql = databaseMock.queries[0];
    expect(sql).toContain("child.checkpoint ->> 'parentJobId' = latest.id::text");
    expect(sql).toContain("children.active_count > 0");
    expect(sql).toContain("children.failed_count > 0");
    expect(sql).toContain("child.state in ('succeeded', 'failed', 'cancelled')");
    expect(sql).toContain("else child_failure.id");
  });
});
