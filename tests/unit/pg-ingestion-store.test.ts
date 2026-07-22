import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ParsedProjectMention } from "../../lib/ingestion";
import type { GitHubRepositoryMetadata } from "../../lib/integrations";
import { PgIngestionStore } from "../../worker/implementations";

const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const VIDEO_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const repository: GitHubRepositoryMetadata = {
  providerRepositoryId: "42",
  owner: "acme",
  name: "tool",
  canonicalUrl: "https://github.com/acme/tool",
  topics: [],
  languages: {},
  stars: 10,
  forks: 1,
  openIssues: 0,
  archived: false,
  fork: false,
};

interface RecordedQuery { text: string; values?: unknown[] }

function fakePool(responder: (text: string, values?: unknown[]) => { rows: unknown[] } = () => ({ rows: [] })) {
  const queries: RecordedQuery[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    queries.push({ text, values });
    return responder(text, values);
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, queries };
}

function githubMention(url: string, rawUrl = url): ParsedProjectMention {
  return {
    ordinal: 0,
    timestampText: "0:00",
    timestampSeconds: 0,
    name: "Bar",
    links: [{
      rawUrl,
      resolvedUrl: url,
      canonicalUrl: url,
      kind: "github_repo",
      githubRepoKey: "foo/bar",
      inferredScheme: false,
    }],
    primaryLinkIndex: 0,
    sourceLineStart: 1,
    sourceLineEnd: 1,
    sourceOffsetStart: 0,
    sourceOffsetEnd: rawUrl.length,
    rawSegment: `0:00 Bar ${rawUrl}`,
    warnings: [],
  };
}

describe("PgIngestionStore", () => {
  it("purges policy-restricted video and raw description fields atomically", async () => {
    const fake = fakePool((text) =>
      text.includes("select v.availability")
        ? { rows: [{ availability: "available", had_restricted_data: true }] }
        : { rows: [] },
    );
    const store = new PgIngestionStore(fake.pool);
    await store.markVideoUnavailable(VIDEO_ID, CORRELATION_ID);

    expect(fake.queries.map(({ text }) => text.trim())).toEqual([
      "begin",
      expect.stringContaining("select v.availability"),
      expect.stringContaining("update video_sources set title = null, description = null"),
      expect.stringContaining("update sightings set raw_segment = null"),
      expect.stringContaining("'youtube_source.unavailable'"),
      "commit",
    ]);
    expect(fake.queries[2].values).toEqual([VIDEO_ID]);
    expect(fake.queries[3].values).toEqual([VIDEO_ID]);
    expect(fake.queries[4].values).toEqual([
      VIDEO_ID,
      CORRELATION_ID,
      JSON.stringify({ availability: "available", retainedSourceData: true }),
      JSON.stringify({ availability: "unavailable", retainedSourceData: false }),
    ]);
  });

  it("uses one canonical GitHub identity for URL variants while preserving source provenance", async () => {
    const fake = fakePool((text) => {
      if (text.includes("insert into projects")) {
        return { rows: [{ id: PROJECT_ID, state: "active", merged_into_project_id: null }] };
      }
      return { rows: [] };
    });
    const store = new PgIngestionStore(fake.pool);
    const variants = [
      "https://github.com/Foo/Bar.git",
      "https://github.com/foo/bar/tree/main",
    ];
    for (const variant of variants) {
      await store.ingestParsedVideo(
        { id: VIDEO_ID, channelId: CHANNEL_ID, youtubeVideoId: "KITOm0HitpY" },
        [githubMention(variant)],
        "youtube-description/v1",
        false,
        CORRELATION_ID,
      );
    }

    const projectLookups = fake.queries.filter(({ text }) => text.includes("normalized_primary_url = $1"));
    expect(projectLookups).toHaveLength(2);
    expect(projectLookups.every(({ text }) => text.includes("for update"))).toBe(true);
    expect(projectLookups.map(({ values }) => values)).toEqual([
      ["https://github.com/foo/bar"],
      ["https://github.com/foo/bar"],
    ]);
    const projectInserts = fake.queries.filter(({ text }) => text.includes("insert into projects"));
    expect(projectInserts.every(({ text }) => text.includes("on conflict (normalized_primary_url)") && text.includes("$1"))).toBe(true);
    expect(projectInserts.map(({ values }) => values?.[2])).toEqual([
      "https://github.com/foo/bar",
      "https://github.com/foo/bar",
    ]);

    const linkQueries = fake.queries.filter(({ text }) => text.includes("insert into project_links"));
    expect(linkQueries.map(({ values }) => values?.[3])).toEqual(variants);
    const sightingQueries = fake.queries.filter(({ text }) => text.includes("insert into sightings"));
    expect(sightingQueries[0].text).toContain("raw_segment = excluded.raw_segment");
    expect(sightingQueries[0].text).toContain("original_url = excluded.original_url");
    expect(sightingQueries[0].text).toContain("parser_version = excluded.parser_version");
    expect(sightingQueries.map(({ values }) => values?.[6])).toEqual(variants);
    for (const query of [...projectInserts, ...linkQueries, ...sightingQueries]) {
      expect(query.text).not.toContain("https://github.com/Foo/Bar.git");
      expect(query.text).not.toContain("https://github.com/foo/bar/tree/main");
    }
  });

  it("audits stale raw-segment purges with the ingestion correlation ID", async () => {
    const oldSightingId = "99999999-9999-4999-8999-999999999999";
    const fake = fakePool((text) => {
      if (text.includes("insert into projects")) {
        return { rows: [{ id: PROJECT_ID, state: "active", merged_into_project_id: null }] };
      }
      if (text.includes("select id, timestamp_seconds, normalized_url from sightings")) {
        return { rows: [{ id: oldSightingId, timestamp_seconds: 30, normalized_url: "https://old.example" }] };
      }
      return { rows: [] };
    });
    const store = new PgIngestionStore(fake.pool);
    await store.ingestParsedVideo(
      { id: VIDEO_ID, channelId: CHANNEL_ID, youtubeVideoId: "KITOm0HitpY" },
      [githubMention("https://github.com/foo/bar")],
      "youtube-description/v1",
      true,
      CORRELATION_ID,
    );

    const purge = fake.queries.find(({ text }) => text.includes("set raw_segment = null") && text.includes("where id = $1"));
    expect(purge?.values).toEqual([oldSightingId]);
    const audit = fake.queries.find(({ text }) => text.includes("youtube_source.raw_segments_purged"));
    expect(audit?.values).toEqual([
      VIDEO_ID,
      CORRELATION_ID,
      JSON.stringify({ retainedRawSegmentCount: 1 }),
      JSON.stringify({ retainedRawSegmentCount: 0 }),
    ]);
  });

  it("routes new sightings through a merged URL match to its canonical project", async () => {
    const mergedProjectId = "77777777-7777-4777-8777-777777777777";
    const canonicalProjectId = "88888888-8888-4888-8888-888888888888";
    const fake = fakePool((text) => {
      if (text.includes("normalized_primary_url = $1")) {
        return { rows: [{ id: mergedProjectId, state: "merged", merged_into_project_id: canonicalProjectId }] };
      }
      if (text.includes("from projects where id = $1")) {
        return { rows: [{ id: canonicalProjectId, state: "active", merged_into_project_id: null }] };
      }
      return { rows: [] };
    });
    const store = new PgIngestionStore(fake.pool);
    const websiteMention: ParsedProjectMention = {
      ...githubMention("https://project.example"),
      links: [{
        rawUrl: "https://project.example",
        resolvedUrl: "https://project.example/",
        canonicalUrl: "https://project.example",
        kind: "website",
        inferredScheme: false,
      }],
    };

    await store.ingestParsedVideo(
      { id: VIDEO_ID, channelId: CHANNEL_ID, youtubeVideoId: "KITOm0HitpY" },
      [websiteMention],
      "youtube-description/v1",
      false,
      CORRELATION_ID,
    );

    expect(fake.queries.some(({ text }) => text.includes("insert into projects"))).toBe(false);
    const link = fake.queries.find(({ text }) => text.includes("insert into project_links"));
    const sighting = fake.queries.find(({ text }) => text.includes("insert into sightings"));
    expect(link?.values?.[0]).toBe(canonicalProjectId);
    expect(sighting?.values?.[0]).toBe(canonicalProjectId);
    expect(fake.queries.find(({ text }) => text.includes("from projects where id = $1"))?.values).toEqual([canonicalProjectId]);
  });

  it("routes delayed website work through a merged project ID", async () => {
    const canonicalProjectId = "88888888-8888-4888-8888-888888888888";
    const fake = fakePool((text, values) => {
      if (text.includes("from projects where id = $1") && values?.[0] === PROJECT_ID) {
        return { rows: [{ id: PROJECT_ID, state: "merged", merged_into_project_id: canonicalProjectId }] };
      }
      if (text.includes("from projects where id = $1") && values?.[0] === canonicalProjectId) {
        return { rows: [{ id: canonicalProjectId, state: "active", merged_into_project_id: null }] };
      }
      return { rows: [] };
    });
    const store = new PgIngestionStore(fake.pool);

    const resolved = await store.ensureWebsiteProject(PROJECT_ID, "https://project.example");

    expect(resolved).toBe(canonicalProjectId);
    const link = fake.queries.find(({ text }) => text.includes("insert into project_links"));
    expect(link?.values?.[0]).toBe(canonicalProjectId);
  });

  it("routes delayed repository candidates through a merged project ID", async () => {
    const canonicalProjectId = "88888888-8888-4888-8888-888888888888";
    const fake = fakePool((text, values) => {
      if (text.includes("from projects where id = $1") && values?.[0] === PROJECT_ID) {
        return { rows: [{ id: PROJECT_ID, state: "merged", merged_into_project_id: canonicalProjectId }] };
      }
      if (text.includes("from projects where id = $1") && values?.[0] === canonicalProjectId) {
        return { rows: [{ id: canonicalProjectId, state: "active", merged_into_project_id: null }] };
      }
      return { rows: [] };
    });
    const store = new PgIngestionStore(fake.pool);

    await store.addRepositoryCandidates([{
      projectId: PROJECT_ID,
      repository,
      discoveryMethod: "github_search",
      evidence: { query: "tool" },
      scoreBasisPoints: 8_000,
    }]);

    const candidate = fake.queries.find(({ text }) => text.includes("insert into repository_candidates"));
    expect(candidate?.values?.[0]).toBe(canonicalProjectId);
  });

  it("rejects delayed writes to archived projects before mutating metadata", async () => {
    const fake = fakePool((text, values) => {
      if (text.includes("from projects where id = $1") && values?.[0] === PROJECT_ID) {
        return { rows: [{ id: PROJECT_ID, state: "archived", merged_into_project_id: null }] };
      }
      return { rows: [] };
    });
    const store = new PgIngestionStore(fake.pool);

    await expect(store.ensureWebsiteProject(PROJECT_ID, "https://project.example"))
      .rejects.toThrow("Archived projects cannot receive ingestion writes.");
    expect(fake.queries.some(({ text }) => text.includes("insert into project_links"))).toBe(false);
    expect(fake.queries.at(-1)?.text.trim()).toBe("rollback");
  });

  it("creates an admin candidate instead of silently stealing an existing repository identity", async () => {
    const existingProjectId = "88888888-8888-4888-8888-888888888888";
    const fake = fakePool((text, values) => {
      if (text.includes("from projects where id = $1") && values?.[0] === PROJECT_ID) {
        return { rows: [{ id: PROJECT_ID, state: "active", merged_into_project_id: null }] };
      }
      if (text.includes("from projects where id = $1") && values?.[0] === existingProjectId) {
        return { rows: [{ id: existingProjectId, state: "active", merged_into_project_id: null }] };
      }
      if (text.includes("select id, project_id, provider_repository_id from repositories")) {
        return { rows: [{
          id: "99999999-9999-4999-8999-999999999999",
          project_id: existingProjectId,
          provider_repository_id: "42",
        }] };
      }
      return { rows: [] };
    });
    const store = new PgIngestionStore(fake.pool);

    const resolved = await store.attachRepository(PROJECT_ID, repository);

    expect(resolved).toBe(PROJECT_ID);
    expect(fake.queries.some(({ text }) => text.includes("verified_identity_conflict"))).toBe(true);
    expect(fake.queries.some(({ text }) => text.includes("review_state = 'needs_review'"))).toBe(true);
    expect(fake.queries.some(({ text }) => text.includes("update repositories set"))).toBe(false);
    expect(fake.queries.some(({ text }) => text.includes("verification_state, verified_at"))).toBe(false);
  });

  it("uses stable provider identity to refresh a renamed repository", async () => {
    const repositoryId = "99999999-9999-4999-8999-999999999999";
    const renamed = {
      ...repository,
      owner: "new-org",
      name: "new-tool",
      canonicalUrl: "https://github.com/new-org/new-tool",
    };
    const fake = fakePool((text, values) => {
      if (text.includes("select id, project_id, provider_repository_id") && text.includes("provider_repository_id = $1")) {
        return { rows: [{ id: repositoryId, project_id: PROJECT_ID, provider_repository_id: "42" }] };
      }
      if (text.includes("select id, project_id, provider_repository_id") && text.includes("lower(owner) = $1")) {
        return { rows: [] };
      }
      if (text.includes("from projects where id = $1") && values?.[0] === PROJECT_ID) {
        return { rows: [{ id: PROJECT_ID, state: "active", merged_into_project_id: null }] };
      }
      if (text.includes("update repositories set")) return { rows: [{ id: repositoryId }] };
      return { rows: [] };
    });
    const store = new PgIngestionStore(fake.pool);

    await expect(store.attachRepository(undefined, renamed)).resolves.toBe(PROJECT_ID);

    const update = fake.queries.find(({ text }) => text.includes("update repositories set"));
    expect(update?.text).toContain("provider_repository_id=$2, owner=$3, name=$4, canonical_url=$5");
    expect(update?.values?.slice(0, 5)).toEqual([
      repositoryId,
      "42",
      "new-org",
      "new-tool",
      "https://github.com/new-org/new-tool",
    ]);
    expect(fake.queries.some(({ text }) => text.includes("verified_identity_conflict"))).toBe(false);
  });

  it("creates an admin candidate when owner/name is already bound to a different provider ID", async () => {
    const existingProjectId = "88888888-8888-4888-8888-888888888888";
    const fake = fakePool((text, values) => {
      if (text.includes("select id, project_id, provider_repository_id") && text.includes("provider_repository_id = $1")) {
        return { rows: [] };
      }
      if (text.includes("select id, project_id, provider_repository_id") && text.includes("lower(owner) = $1")) {
        return { rows: [{
          id: "99999999-9999-4999-8999-999999999999",
          project_id: existingProjectId,
          provider_repository_id: "different-stable-id",
        }] };
      }
      if (text.includes("from projects where id = $1") && values?.[0] === PROJECT_ID) {
        return { rows: [{ id: PROJECT_ID, state: "active", merged_into_project_id: null }] };
      }
      if (text.includes("from projects where id = $1") && values?.[0] === existingProjectId) {
        return { rows: [{ id: existingProjectId, state: "active", merged_into_project_id: null }] };
      }
      return { rows: [] };
    });
    const store = new PgIngestionStore(fake.pool);

    await expect(store.attachRepository(PROJECT_ID, repository)).resolves.toBe(PROJECT_ID);

    const candidate = fake.queries.find(({ text }) => text.includes("verified_identity_conflict"));
    expect(JSON.parse(String(candidate?.values?.[6]))).toMatchObject({
      reason: "repository_name_reused",
      existingProjectId,
      providerRepositoryId: "42",
    });
    expect(fake.queries.some(({ text }) => text.includes("update repositories set"))).toBe(false);
    expect(fake.queries.some(({ text }) => text.includes("insert into repositories"))).toBe(false);
  });

  it("stores official video data with a database retention deadline using parameters", async () => {
    const fake = fakePool((text) => text.includes("returning id")
      ? { rows: [{ id: VIDEO_ID, channel_id: CHANNEL_ID, youtube_video_id: "KITOm0HitpY" }] }
      : { rows: [] });
    const store = new PgIngestionStore(fake.pool);
    await store.upsertVideo(CHANNEL_ID, {
      id: "KITOm0HitpY",
      channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      title: "Official title",
      description: "Official description",
      durationSeconds: 90,
    });

    const query = fake.queries[0];
    expect(query.text).toContain("youtube_data_expires_at");
    expect(query.text).toContain("now() + interval '30 days'");
    expect(query.text).toContain("values ($1, $2, $3, $4");
    expect(query.text).not.toContain("Official description");
    expect(query.values).toEqual([
      CHANNEL_ID,
      "KITOm0HitpY",
      "Official title",
      "Official description",
      null,
      null,
      90,
    ]);
  });
});
