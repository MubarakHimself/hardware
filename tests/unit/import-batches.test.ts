import { describe, expect, it, vi } from "vitest";
import {
  importBatchRequestSchema,
  validateImportBatchItems,
} from "../../lib/validation";

vi.mock("server-only", () => ({}));

import {
  deriveCurrentImportBatchState,
  deriveImportBatchState,
} from "../../lib/server/import-batches";

describe("bulk import validation", () => {
  it("reports partial success when a valid duplicate survives beside an invalid row", () => {
    expect(deriveImportBatchState(0, 1, 1)).toBe("partial");
    expect(deriveImportBatchState(0, 0, 2)).toBe("failed");
    expect(deriveImportBatchState(2, 0, 0)).toBe("queued");
  });

  it("derives aggregate completion from current child terminal outcomes", () => {
    expect(deriveCurrentImportBatchState([
      { submissionState: "queued", jobState: "running" },
      { submissionState: "queued", jobState: "succeeded" },
    ])).toBe("queued");
    expect(deriveCurrentImportBatchState([
      { submissionState: "queued", jobState: "failed" },
      { submissionState: "queued", jobState: "succeeded" },
    ])).toBe("partial");
    expect(deriveCurrentImportBatchState([
      { submissionState: "queued", jobState: "succeeded" },
      { submissionState: "duplicate", jobState: null },
    ])).toBe("succeeded");
    expect(deriveCurrentImportBatchState([
      { submissionState: "queued", jobState: "cancelled" },
      { submissionState: "invalid", jobState: null },
    ])).toBe("failed");
  });

  it("normalizes valid rows and marks repeated canonical identities without rejecting siblings", () => {
    const rows = validateImportBatchItems([
      { kind: "youtube_video", url: "https://youtu.be/KITOm0HitpY" },
      { kind: "youtube_video", url: "https://youtube.com/watch?v=KITOm0HitpY&t=10" },
      { kind: "youtube_channel", url: "https://www.youtube.com/@GoogleDevelopers/videos" },
      { kind: "youtube_channel", url: "https://m.youtube.com/@googledevelopers" },
      { kind: "website", url: "https://Project.Example/?utm_source=video&b=2&a=1" },
      { kind: "website", url: "not a public URL" },
    ]);

    expect(rows[0]).toMatchObject({
      normalizedUrl: "https://www.youtube.com/watch?v=KITOm0HitpY",
      duplicateOfOrdinal: null,
    });
    expect(rows[1]).toMatchObject({
      normalizedUrl: "https://www.youtube.com/watch?v=KITOm0HitpY",
      duplicateOfOrdinal: 1,
    });
    expect(rows[2]).toMatchObject({
      normalizedUrl: "https://www.youtube.com/@googledevelopers",
      duplicateOfOrdinal: null,
    });
    expect(rows[3]).toMatchObject({
      normalizedUrl: "https://www.youtube.com/@googledevelopers",
      duplicateOfOrdinal: 3,
    });
    expect(rows[4]).toMatchObject({
      normalizedUrl: "https://project.example?a=1&b=2",
      duplicateOfOrdinal: null,
    });
    expect(rows[5]).toMatchObject({
      input: null,
      validationCode: "INVALID_IMPORT_ITEM",
    });
  });

  it("does not retain an invalid URL containing credentials", () => {
    const [row] = validateImportBatchItems([
      { kind: "website", url: "https://user:password@example.com/private" },
    ]);
    expect(row.input).toBeNull();
    expect(row.originalUrl).toBeNull();
  });

  it("bounds a batch before item processing", () => {
    expect(() => importBatchRequestSchema.parse({ items: [] })).toThrow();
    expect(() => importBatchRequestSchema.parse({
      items: Array.from({ length: 501 }, () => ({ kind: "website", url: "https://example.com" })),
    })).toThrow();
  });
});
