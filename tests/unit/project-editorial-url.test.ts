import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  normalizedEditorialProjectUrl,
  projectPatchSchema,
  projectSplitSchema,
} from "../../lib/server/project-mutations";

describe("editorial project URL contract", () => {
  it("uses the ingestion normalizer for trackers, default ports, fragments, and query order", () => {
    expect(
      normalizedEditorialProjectUrl(
        "HTTPS://Example.COM:443/?utm_source=video&z=2&a=1#section",
      ),
    ).toBe("https://example.com?a=1&z=2");
  });

  it("rejects YouTube-internal URLs as canonical project destinations", () => {
    expect(
      projectPatchSchema.safeParse({
        version: 1,
        primaryUrl: "https://www.youtube.com/watch?v=KITOm0HitpY",
      }).success,
    ).toBe(false);
    expect(
      projectSplitSchema.safeParse({
        name: "Not a project destination",
        sourceVersion: 1,
        sightingIds: ["sighting-1"],
        primaryUrl: "https://youtu.be/KITOm0HitpY",
      }).success,
    ).toBe(false);
  });
});
