import { describe, expect, it } from "vitest";
import { normalizeCandidate, normalizeChannel, normalizeJob, normalizeProject } from "../../lib/client/contracts";
import { contrastTextColor } from "../../lib/utils";

describe("client DTO normalization", () => {
  it("maps repository candidate basis points to a percent", () => {
    expect(normalizeCandidate({
      id: "candidate",
      projectId: "project",
      projectName: "Project",
      owner: "owner",
      name: "repo",
      scoreBasisPoints: 8_650,
      state: "pending",
    })).toEqual(expect.objectContaining({ repository: "owner/repo", score: 87 }));
  });

  it("maps the production channel DTO fields", () => {
    const channel = normalizeChannel({
      id: "channel",
      title: "ManuAGI",
      handle: "@ManuAGI",
      status: "attention",
      videoCount: 184,
      projectCount: 1_432,
      progress: 94,
      progressLabel: "182 of 184 items",
      warningCount: 1,
      failureCount: 2,
      lastSyncedAt: "2026-07-22T10:00:00.000Z",
      nextSyncAt: "2026-07-22T16:00:00.000Z",
      retryableJobId: "job",
    });
    expect(channel).toEqual(expect.objectContaining({
      name: "ManuAGI",
      status: "attention",
      videos: 184,
      projects: 1_432,
      warnings: 1,
      failures: 2,
      progress: 94,
      retryableJobId: "job",
    }));
    expect(channel.lastSync).not.toBe("Not synced yet");
    expect(channel.nextSync).not.toBe("within 6 hours");
  });

  it("preserves private note versions for optimistic concurrency", () => {
    const project = normalizeProject({
      id: "project",
      slug: "project",
      name: "Project",
      primaryUrl: "https://example.com",
      repositoryState: "none",
      note: { body: "Private", version: 4 },
    });
    expect(project).toEqual(expect.objectContaining({
      note: "Private",
      noteVersion: 4,
      version: 1,
      reviewState: "unreviewed",
    }));
  });

  it("maps the project-detail repository state contract", () => {
    const project = normalizeProject({
      id: "project",
      name: "Project",
      primaryUrl: "https://github.com/example/project",
      repositoryState: "attached",
      repository: {
        owner: "example",
        name: "project",
        canonicalUrl: "https://github.com/example/project",
      },
    });
    expect(project.repositoryState).toBe("verified");
    expect(project.repositoryLabel).toBe("example/project");
  });

  it("normalizes the stable job DTO without exposing checkpoint payloads", () => {
    const job = normalizeJob({
      id: "job",
      type: "repository_refresh",
      state: "failed",
      scopeType: "repository",
      scopeId: "repo",
      attempts: 3,
      maxAttempts: 3,
      safeErrorCode: "GITHUB_UNAVAILABLE",
      safeErrorSummary: "GitHub metadata was temporarily unavailable.",
      requestedByMe: true,
      canRetry: true,
      checkpoint: { token: "must-not-cross-the-client-contract" },
    });
    expect(job).toEqual(expect.objectContaining({
      id: "job",
      type: "repository_refresh",
      state: "failed",
      safeErrorCode: "GITHUB_UNAVAILABLE",
      requestedByMe: true,
      canRetry: true,
    }));
    expect(job).not.toHaveProperty("checkpoint");
  });

  it("chooses a readable avatar foreground for light and dark accents", () => {
    expect(contrastTextColor("#ad7133")).toBe("#0a0d0b");
    expect(contrastTextColor("#6546c7")).toBe("#ffffff");
  });
});
