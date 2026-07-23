import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_DESCRIPTION_CHARACTERS,
  normalizeProjectUrl,
  parseYouTubeDescription,
  timestampToSeconds,
} from "../../lib/ingestion";
import goldenExpected from "../fixtures/youtube/KITOm0HitpY.expected.json";

const goldenDescription = readFileSync(
  new URL("../fixtures/youtube/KITOm0HitpY.description.txt", import.meta.url),
  "utf8",
);

describe("YouTube description parser", () => {
  it("parses the KITOm0HitpY golden fixture into exactly 20 sightings", () => {
    const parsed = parseYouTubeDescription({
      videoId: "KITOm0HitpY",
      description: goldenDescription,
      durationSeconds: 1_049,
    });

    expect(parsed.parserVersion).toBe("youtube-description/v1");
    expect(parsed.mentions).toHaveLength(20);
    expect(
      parsed.mentions.map((mention) => ({
        timestampText: mention.timestampText,
        timestampSeconds: mention.timestampSeconds,
        name: mention.name,
        canonicalUrl: mention.links[mention.primaryLinkIndex].canonicalUrl,
      })),
    ).toEqual(goldenExpected);

    expect(parsed.rejectedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timestampText: "00:00",
          timestampSeconds: 0,
          reason: "NO_EXTERNAL_URL",
        }),
      ]),
    );

    const ignored = parsed.ignoredLinks.map((link) => link.rawUrl);
    expect(ignored).toEqual(
      expect.arrayContaining([
        "https://www.youtube.com/channel/UCAawqobkJZ28OLcYcMgqYaw",
        "https://manuagi.beehiiv.com/subscribe",
        "https://try.elevenlabs.io/0wgaz29csuo5",
        "https://www.dzine.ai/src/BnkUwm2a",
        "https://twitter.com/ManuAGI01",
      ]),
    );

    for (const mention of parsed.mentions) {
      const primary = mention.links[mention.primaryLinkIndex];
      expect(mention.rawSegment).toContain(mention.timestampText);
      expect(mention.rawSegment).toContain(primary.rawUrl);
      expect(primary.canonicalUrl).not.toContain("ref=manuagi");
      expect(
        goldenDescription.slice(
          mention.sourceOffsetStart,
          mention.sourceOffsetEnd,
        ),
      ).toBe(mention.rawSegment);
    }
  });

  it("accepts supported timestamp syntax and rejects invalid components", () => {
    expect(timestampToSeconds("0:05")).toBe(5);
    expect(timestampToSeconds("12:34")).toBe(754);
    expect(timestampToSeconds("1:02:03")).toBe(3_723);
    expect(timestampToSeconds("01:60")).toBeUndefined();
    expect(timestampToSeconds("1:60:00")).toBeUndefined();

    const parsed = parseYouTubeDescription({
      videoId: "syntax",
      description: [
        "[00:05] - Bracketed https://example.com/bracketed",
        "• 1:02:03 | Long project",
        "",
        "https://example.com/long",
        "01:60 - Invalid https://example.com/invalid",
        "1:2 - Also invalid https://example.com/also-invalid",
        "2026-07-21 is not a timestamp https://example.com/date",
      ].join("\n"),
    });

    expect(parsed.mentions.map((mention) => mention.timestampSeconds)).toEqual([
      5,
      3_723,
    ]);
    expect(
      parsed.diagnostics.filter(
        (item) => item.code === "MALFORMED_TIMESTAMP",
      ),
    ).toHaveLength(2);
  });

  it("associates a URL anywhere in the complete timestamp block", () => {
    const parsed = parseYouTubeDescription({
      videoId: "continuations",
      description: [
        "00:01 - Immediate",
        "https://example.com/immediate",
        "00:02 - One blank",
        "",
        "https://example.com/one-blank",
        "00:03 - Too far",
        "",
        "",
        "https://example.com/too-far",
      ].join("\n"),
    });

    expect(parsed.mentions.map((mention) => mention.name)).toEqual([
      "Immediate",
      "One blank",
      "Too far",
    ]);
    expect(parsed.mentions[2].rawSegment).toBe(
      "00:03 - Too far\n\n\nhttps://example.com/too-far",
    );
  });

  it("retains multiple eligible links but makes the first one primary", () => {
    const parsed = parseYouTubeDescription({
      videoId: "multiple",
      description:
        "00:01 - Project https://example.com https://github.com/Acme/Project",
    });

    expect(parsed.mentions).toHaveLength(1);
    expect(parsed.mentions[0].links).toHaveLength(2);
    expect(parsed.mentions[0].links[0].canonicalUrl).toBe(
      "https://example.com",
    );
    expect(parsed.mentions[0].links[1].githubRepoKey).toBe("acme/project");
    expect(parsed.mentions[0].warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MULTIPLE_URLS" }),
      ]),
    );
  });

  it("handles markdown wrappers, trailing punctuation, and www URLs", () => {
    const markdown = parseYouTubeDescription({
      videoId: "markdown",
      description: "00:01 - [Project](https://example.com/tool).",
    });
    expect(markdown.mentions[0].name).toBe("Project");
    expect(markdown.mentions[0].links[0].rawUrl).toBe(
      "https://example.com/tool",
    );

    const inferred = parseYouTubeDescription({
      videoId: "www",
      description: "00:02 - Site www.example.com/path,",
    });
    expect(inferred.mentions[0].links[0]).toEqual(
      expect.objectContaining({
        rawUrl: "www.example.com/path",
        inferredScheme: true,
        canonicalUrl: "https://www.example.com/path",
      }),
    );
  });

  it("does not attach unscoped sponsor, newsletter, social, or YouTube links", () => {
    const parsed = parseYouTubeDescription({
      videoId: "exclusions",
      description: [
        "Newsletter https://newsletter.example/subscribe",
        "00:01 - Project https://project.example",
        "Sponsor https://sponsor.example/deal",
        "Social https://twitter.com/example",
        "Channel https://youtube.com/@example",
      ].join("\n"),
    });

    expect(parsed.mentions).toHaveLength(1);
    expect(parsed.mentions[0].links).toHaveLength(1);
    expect(parsed.mentions[0].rawSegment).toContain(
      "Channel https://youtube.com/@example",
    );
    expect(parsed.ignoredLinks).toHaveLength(4);
    expect(parsed.ignoredLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rawUrl: "https://sponsor.example/deal" }),
        expect.objectContaining({
          rawUrl: "https://youtube.com/@example",
          reason: "YOUTUBE_INTERNAL",
        }),
      ]),
    );
  });

  it("preserves source order and warns about range and ordering", () => {
    const parsed = parseYouTubeDescription({
      videoId: "ordering",
      durationSeconds: 60,
      description: [
        "02:00 - Later https://example.com/later",
        "00:10 - Earlier https://example.com/earlier",
      ].join("\n"),
    });

    expect(parsed.mentions.map((mention) => mention.name)).toEqual([
      "Later",
      "Earlier",
    ]);
    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TIMESTAMP_OUT_OF_RANGE", line: 1 }),
        expect.objectContaining({ code: "NON_MONOTONIC_TIMESTAMP", line: 2 }),
      ]),
    );
  });

  it("is deterministic and preserves CRLF raw segments", () => {
    const description =
      "00:01 - Project\r\nhttps://example.com/project?utm_source=test\r\n";
    const first = parseYouTubeDescription({ videoId: "stable", description });
    const second = parseYouTubeDescription({ videoId: "stable", description });

    expect(second).toEqual(first);
    expect(first.mentions[0].rawSegment).toBe(
      "00:01 - Project\r\nhttps://example.com/project?utm_source=test",
    );
  });

  it("rejects oversized input without partial parsing", () => {
    const parsed = parseYouTubeDescription({
      videoId: "large",
      description: `00:01 - A https://example.com/${"x".repeat(
        MAX_DESCRIPTION_CHARACTERS,
      )}`,
    });

    expect(parsed.mentions).toHaveLength(0);
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        code: "DESCRIPTION_TOO_LARGE",
        severity: "error",
      }),
    ]);
  });
});

describe("project URL normalization", () => {
  it("normalizes conservatively and strips only allowlisted trackers", () => {
    const normalized = normalizeProjectUrl(
      "HTTPS://Example.COM:443/tool/?b=2&utm_source=test&a=1&ref=manuagi#readme",
    );

    expect(normalized).toEqual({
      ok: true,
      link: expect.objectContaining({
        canonicalUrl: "https://example.com/tool/?a=1&b=2",
        kind: "website",
      }),
    });

    const functional = normalizeProjectUrl(
      "https://example.com/tool?edition=cloud",
    );
    expect(functional.ok && functional.link.canonicalUrl).toBe(
      "https://example.com/tool?edition=cloud",
    );
  });

  it("unwraps supported YouTube redirects exactly once", () => {
    const target = "https://example.com/a%2Fb?query=%2520&utm_medium=video";
    const wrapper = `https://www.youtube.com/redirect?event=video_description&q=${encodeURIComponent(
      target,
    )}&v=video`;
    const normalized = normalizeProjectUrl(wrapper);

    expect(normalized).toEqual({
      ok: true,
      link: expect.objectContaining({
        rawUrl: wrapper,
        resolvedUrl: target,
        canonicalUrl: "https://example.com/a%2Fb?query=%2520",
      }),
    });

    expect(
      normalizeProjectUrl("https://youtube.com/redirect?event=x"),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: "UNRESOLVABLE_YOUTUBE_REDIRECT",
      }),
    );
  });

  it("rejects YouTube navigation, unsupported protocols, and credentials", () => {
    expect(normalizeProjectUrl("https://youtu.be/video")).toEqual(
      expect.objectContaining({ ok: false, code: "YOUTUBE_INTERNAL" }),
    );
    expect(normalizeProjectUrl("file:///etc/passwd")).toEqual(
      expect.objectContaining({ ok: false, code: "UNSUPPORTED_PROTOCOL" }),
    );
    expect(normalizeProjectUrl("https://user:password@example.com")).toEqual(
      expect.objectContaining({ ok: false, code: "URL_HAS_CREDENTIALS" }),
    );
    expect(
      normalizeProjectUrl("https://example.com/project?api_key=secret"),
    ).toEqual(expect.objectContaining({ ok: false, code: "SENSITIVE_QUERY" }));
  });

  it("recognizes equivalent GitHub repository identities", () => {
    const urls = [
      "https://github.com/Foo/Bar",
      "https://github.com/foo/bar.git",
      "https://github.com/FOO/BAR/tree/main",
    ];

    expect(
      urls.map((url) => {
        const normalized = normalizeProjectUrl(url);
        return normalized.ok ? normalized.link.githubRepoKey : undefined;
      }),
    ).toEqual(["foo/bar", "foo/bar", "foo/bar"]);
  });

  it("deduplicates tracking variants within one row but not separate sightings", () => {
    const parsed = parseYouTubeDescription({
      videoId: "dedupe",
      description: [
        "00:01 - First https://example.com/tool?ref=one https://example.com/tool?utm_source=two",
        "00:02 - First again https://example.com/tool",
        "00:03 - Same name https://different.example/tool",
      ].join("\n"),
    });

    expect(parsed.mentions).toHaveLength(3);
    expect(parsed.mentions[0].links).toHaveLength(1);
    expect(parsed.mentions[0].warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_LINK" }),
      ]),
    );
    expect(parsed.mentions[0].links[0].canonicalUrl).toBe(
      parsed.mentions[1].links[0].canonicalUrl,
    );
    expect(parsed.mentions[2].links[0].canonicalUrl).not.toBe(
      parsed.mentions[1].links[0].canonicalUrl,
    );
  });
});
