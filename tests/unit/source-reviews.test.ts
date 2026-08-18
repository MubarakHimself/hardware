import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const databaseMock = vi.hoisted(() => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let reviewRows: Array<Record<string, unknown>> = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    queries.push({ text, values });
    if (text.includes("from source_reviews r")) return { rows: reviewRows };
    if (text.includes("count(*) filter")) {
      return { rows: [{ totalCount: 205, openCount: 205 }] };
    }
    return { rows: [] };
  });
  return {
    queries,
    query,
    pool: { query },
    setRows: (rows: Array<Record<string, unknown>>) => {
      reviewRows = rows;
    },
  };
});

vi.mock("../../db/index", () => ({ getPool: () => databaseMock.pool }));
vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => ({ mode: "local" }),
}));

import {
  listSourceReviews,
  sourceReviewUpdateSchema,
} from "../../lib/server/source-reviews";

const rows = [0, 1, 2].map((index) => ({
  id: `60000000-0000-4000-8000-00000000000${index + 1}`,
  videoSourceId: `70000000-0000-4000-8000-00000000000${index + 1}`,
  youtubeVideoId: `video-${index}`,
  videoTitle: `Video ${index}`,
  channelTitle: "Channel",
  state: "open",
  parserVersion: "youtube-description/v1",
  issueFingerprint: String(index + 1).repeat(64),
  version: index + 1,
  mentionCount: 2,
  warningCount: 1,
  errorCount: index === 0 ? 1 : 0,
  rejectedRowCount: 1,
  ignoredLinkCount: 2,
  diagnosticCodeCounts: {
    EMPTY_DESCRIPTION: 1,
    "unsafe raw key": 99,
  },
  jobId: "80000000-0000-4000-8000-000000000001",
  jobType: "video_ingest",
  jobState: "failed",
  resolutionNote: null,
  resolvedByUserId: null,
  resolvedByDisplayName: null,
  resolvedAt: index === 0 ? new Date("2026-07-22T09:00:00.000Z") : null,
  updatedAt: new Date(`2026-07-22T0${8 - index}:00:00.000Z`),
  // A defensive fake: even if a database adapter adds these fields, the DTO
  // projection must never serialize raw evidence.
  rejectedRows: [{ rawSegment: "secret source text" }],
  ignoredLinks: [{ rawUrl: "https://secret.example" }],
  diagnostics: [{ raw: "secret source text" }],
}));

beforeEach(() => {
  databaseMock.queries.length = 0;
  databaseMock.query.mockClear();
  databaseMock.setRows(rows);
});

describe("source-review queue contract", () => {
  it("paginates beyond one page and returns only safe summaries", async () => {
    const first = await listSourceReviews({ state: "open", limit: 2 });

    expect(first).toMatchObject({
      totalCount: 205,
      openCount: 205,
      items: [
        expect.objectContaining({
          issueFingerprint: "1".repeat(64),
          version: 1,
          warningCount: 1,
          errorCount: 1,
          rejectedRowCount: 1,
          ignoredLinkCount: 2,
          diagnosticCodeCounts: { EMPTY_DESCRIPTION: 1 },
          resolvedAt: "2026-07-22T09:00:00.000Z",
        }),
        expect.anything(),
      ],
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toContain("secret source text");
    expect(JSON.stringify(first)).not.toContain("secret.example");
    expect(first.items[0]).not.toHaveProperty("rejectedRows");
    expect(first.items[0]).not.toHaveProperty("ignoredLinks");
    expect(first.items[0]).not.toHaveProperty("diagnostics");
    expect(databaseMock.queries[0].values).toEqual(["open", null, null, 3]);

    databaseMock.setRows([]);
    await listSourceReviews({
      state: "open",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(databaseMock.queries[2].values).toEqual([
      "open",
      "2026-07-22T07:00:00.000Z",
      rows[1].id,
      3,
    ]);
  });

  it("requires both optimistic evidence tokens for decisions", () => {
    expect(sourceReviewUpdateSchema.safeParse({
      state: "resolved",
      expectedIssueFingerprint: "a".repeat(64),
      expectedVersion: 2,
    }).success).toBe(true);
    expect(sourceReviewUpdateSchema.safeParse({
      state: "resolved",
      expectedVersion: 2,
    }).success).toBe(false);
  });
});
