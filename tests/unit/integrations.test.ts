import { describe, expect, it, vi } from "vitest";
import {
  GitHubClient,
  IntegrationError,
  YouTubeClient,
  parseGitHubRepositoryReference,
  parseYouTubeChannelReference,
  parseYouTubeDuration,
  parseYouTubeVideoId,
  requestJson,
} from "../../lib/integrations";
import { parseIntegrationEnvironment } from "../../worker/implementations/runtime";

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers).entries()) },
  });
}

function mockFetch(implementation: (url: URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => implementation(new URL(String(input)), init)) as typeof fetch;
}

describe("YouTube integration", () => {
  it("accepts channel ID, @handle, and the two supported channel URL forms", () => {
    const id = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
    expect(parseYouTubeChannelReference(id)).toEqual({ kind: "id", value: id });
    expect(parseYouTubeChannelReference("@GoogleDevelopers")).toEqual({ kind: "handle", value: "GoogleDevelopers" });
    expect(parseYouTubeChannelReference(`https://www.youtube.com/channel/${id}/videos`)).toEqual({ kind: "id", value: id });
    expect(parseYouTubeChannelReference("https://youtube.com/@GoogleDevelopers/videos")).toEqual({ kind: "handle", value: "GoogleDevelopers" });
    expect(() => parseYouTubeChannelReference("https://example.com/channel/nope")).toThrowError(IntegrationError);
  });

  it("resolves one unambiguous channel through the official API", async () => {
    const fetchImplementation = vi.fn(mockFetch(async (url) => {
      expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/channels");
      expect(url.searchParams.get("forHandle")).toBe("GoogleDevelopers");
      expect(url.searchParams.get("key")).toBe("test-key");
      return json({ items: [{
        id: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
        snippet: { title: "Google for Developers", customUrl: "@GoogleDevelopers", thumbnails: { high: { url: "https://images.example/channel.jpg" } } },
        contentDetails: { relatedPlaylists: { uploads: "UU_x5XG1OV2P6uZZ5FSM9Ttw" } },
      }] });
    }));
    const client = new YouTubeClient({ apiKey: "test-key", fetchImplementation });
    await expect(client.resolveChannel("@GoogleDevelopers")).resolves.toEqual({
      id: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      uploadsPlaylistId: "UU_x5XG1OV2P6uZZ5FSM9Ttw",
      handle: "@GoogleDevelopers",
      title: "Google for Developers",
      canonicalUrl: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
      thumbnailUrl: "https://images.example/channel.jpg",
    });
  });

  it("returns safe nonexistent/ambiguous errors and classifies quota exhaustion as retryable", async () => {
    const missing = new YouTubeClient({ apiKey: "key", fetchImplementation: mockFetch(async () => json({ items: [] })) });
    await expect(missing.resolveChannel("@missing-channel")).rejects.toMatchObject({ code: "YOUTUBE_CHANNEL_NOT_FOUND", retryable: false });

    const ambiguous = new YouTubeClient({ apiKey: "key", fetchImplementation: mockFetch(async () => json({ items: [
      { id: "UC_x5XG1OV2P6uZZ5FSM9Ttw", snippet: { title: "One" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } },
      { id: "UC_x5XG1OV2P6uZZ5FSM9Ttx", snippet: { title: "Two" }, contentDetails: { relatedPlaylists: { uploads: "UU2" } } },
    ] })) });
    await expect(ambiguous.resolveChannel("@ambiguous")).rejects.toMatchObject({ code: "YOUTUBE_CHANNEL_AMBIGUOUS", retryable: false });

    const limited = new YouTubeClient({ apiKey: "key", fetchImplementation: mockFetch(async () => json({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403)) });
    await expect(limited.listUploadsPage("uploads")).rejects.toMatchObject({ code: "YOUTUBE_RATE_LIMITED", retryable: true, status: 403 });
  });

  it("normalizes video references and parses YouTube durations", () => {
    expect(parseYouTubeVideoId("https://youtu.be/KITOm0HitpY?t=4")).toBe("KITOm0HitpY");
    expect(parseYouTubeVideoId("https://youtube.com/shorts/KITOm0HitpY")).toBe("KITOm0HitpY");
    expect(parseYouTubeDuration("P1DT2H3M4S")).toBe(93_784);
    expect(parseYouTubeDuration("not-a-duration")).toBeUndefined();
  });
});

describe("GitHub integration", () => {
  it("normalizes repository URL variants to the same identity", () => {
    expect(parseGitHubRepositoryReference("Acme/Tool")).toEqual({ owner: "acme", name: "tool", canonicalUrl: "https://github.com/acme/tool" });
    expect(parseGitHubRepositoryReference("https://github.com/Acme/Tool.git/tree/main")).toEqual({ owner: "acme", name: "tool", canonicalUrl: "https://github.com/acme/tool" });
  });

  it("hydrates repository, language, head, and release metadata from REST", async () => {
    const fetchImplementation = vi.fn(mockFetch(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
      if (url.pathname.endsWith("/languages")) return json({ TypeScript: 1200, CSS: 200 });
      if (url.pathname.endsWith("/releases/latest")) return json({ published_at: "2026-01-02T00:00:00Z" });
      if (url.pathname.includes("/commits/")) return json({ sha: "a".repeat(40) });
      return json({
        id: 42, name: "Tool", owner: { login: "Acme" }, html_url: "https://github.com/Acme/Tool",
        homepage: "https://tool.example", description: "Useful", default_branch: "main", topics: ["ai"],
        language: "TypeScript", license: { spdx_id: "MIT" }, stargazers_count: 10, forks_count: 2,
        open_issues_count: 1, archived: false, fork: false, private: false, pushed_at: "2026-01-01T00:00:00Z",
      });
    }));
    const client = new GitHubClient({ token: "token", fetchImplementation });
    await expect(client.getRepository("https://github.com/acme/tool/tree/main")).resolves.toMatchObject({
      providerRepositoryId: "42", owner: "acme", name: "tool", languages: { TypeScript: 1200, CSS: 200 },
      headSha: "a".repeat(40), latestReleaseAt: "2026-01-02T00:00:00Z", stars: 10,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });

  it("classifies GitHub rate limits without leaking provider response text", async () => {
    const client = new GitHubClient({ fetchImplementation: mockFetch(async () => json(
      { message: "secret provider diagnostics" },
      403,
      { "x-ratelimit-remaining": "0", "retry-after": "2" },
    )) });
    await expect(client.searchRepositories("tool")).rejects.toMatchObject({
      code: "GITHUB_RATE_LIMITED", retryable: true, retryAfterMs: 2_000,
      message: "GitHub API rate limit is temporarily exhausted.",
    });
  });
});

describe("bounded JSON transport", () => {
  it("keeps the deadline through a stalled streaming response body and cancels it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    const fetchImplementation = mockFetch(async () => new Response(body, { status: 200 }));
    await expect(requestJson("youtube", new URL("https://www.googleapis.com/test"), {
      fetchImplementation,
      timeoutMs: 10,
    })).rejects.toMatchObject({ code: "YOUTUBE_TIMEOUT", retryable: true });
    expect(cancelled).toBe(true);
  });
});

describe("worker integration configuration", () => {
  it("treats an empty optional GitHub token as absent", () => {
    expect(
      parseIntegrationEnvironment({
        YOUTUBE_API_KEY: "youtube-test-key-with-enough-length",
        GITHUB_TOKEN: "",
      }),
    ).toEqual({
      YOUTUBE_API_KEY: "youtube-test-key-with-enough-length",
      GITHUB_TOKEN: undefined,
      SOURCE_HTTP_TIMEOUT_MS: 10_000,
    });
  });
});
