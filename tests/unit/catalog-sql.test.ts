import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const databaseMock = vi.hoisted(() => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const state: {
    responder: (
      text: string,
      values?: unknown[],
    ) => { rows: Array<Record<string, unknown>>; rowCount?: number };
  } = { responder: () => ({ rows: [], rowCount: 0 }) };
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    queries.push({ text, values });
    const result = state.responder(text, values);
    return { rowCount: result.rowCount ?? result.rows.length, ...result };
  });
  return { queries, query, state };
});

vi.mock("../../db/index", () => ({
  getPool: () => ({ query: databaseMock.query }),
}));
vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => ({ mode: "production" }),
}));

import { getProjectDetail, listProjects } from "../../lib/server/catalog";

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("catalog search SQL", () => {
  beforeEach(() => {
    databaseMock.queries.length = 0;
    databaseMock.query.mockClear();
    databaseMock.state.responder = () => ({ rows: [], rowCount: 0 });
  });

  it("keeps search predicates compatible with the migration index expressions", async () => {
    await listProjects(
      {
        userId: "00000000-0000-4000-8000-000000000010",
        role: "member",
      },
      {
        q: "hardware",
        sort: "relevance",
        view: "cards",
        limit: 24,
      },
    );

    expect(databaseMock.queries).toHaveLength(5);
    const searchSql = compact(databaseMock.queries[0].text);
    expect(searchSql).toContain(
      "lower(r.owner || '/' || r.name) % lower($2)",
    );
    expect(searchSql).not.toContain(
      "lower(coalesce(r.owner, '') || '/' || coalesce(r.name, ''))",
    );
    expect(searchSql).toContain(
      "to_tsvector( 'simple', coalesce(p.name, '') || ' ' || coalesce(p.description, '') || ' ' || coalesce(p.primary_url, '') || ' ' || coalesce(p.normalized_primary_url, '') ) @@ plainto_tsquery('simple', $2)",
    );
    expect(searchSql).toContain(
      "to_tsvector( 'simple', coalesce(r.owner, '') || ' ' || coalesce(r.name, '') || ' ' || coalesce(r.description, '') || ' ' || coalesce(r.primary_language, '') || ' ' || coalesce(r.license_spdx, '') || ' ' || coalesce(r.topics::text, '') ) @@ plainto_tsquery('simple', $2)",
    );

    const facetQuery = databaseMock.queries.find(({ text }) =>
      text.includes("from channel_sources c"),
    );
    expect(facetQuery).toBeDefined();
    const facetSql = compact(facetQuery!.text);
    expect(facetSql).toContain(
      "(count(distinct s.project_id) filter (where p.id is not null))::int",
    );
    expect(
      databaseMock.queries.some(({ text }) =>
        text.includes("r.primary_language as id"),
      ),
    ).toBe(true);
    expect(
      databaseMock.queries.some(({ text }) =>
        text.includes("r.license_spdx as id"),
      ),
    ).toBe(true);
    expect(
      databaseMock.queries.some(({ text }) =>
        text.includes("from collections c"),
      ),
    ).toBe(true);
  });

  it("resolves merged IDs to the canonical project and aggregates predecessor history", async () => {
    const canonicalId = "40000000-0000-4000-8000-000000000001";
    const predecessorId = "40000000-0000-4000-8000-000000000002";
    databaseMock.state.responder = (text) => {
      if (text.includes("with recursive seed")) {
        return { rows: [{ id: canonicalId }] };
      }
      if (text.includes("select p.id, p.slug, p.name")) {
        return {
          rows: [
            {
              id: canonicalId,
              slug: "canonical-project",
              name: "Canonical Project",
              description: null,
              primaryUrl: "https://canonical.example",
              normalizedPrimaryUrl: "https://canonical.example",
              logoUrl: null,
              state: "active",
              reviewState: "reviewed",
              version: 2,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-02T00:00:00.000Z"),
              repositoryId: null,
              privateNote: null,
              isImpressive: false,
            },
          ],
        };
      }
      if (text.includes("with recursive project_family")) {
        return {
          rows: [
            {
              action: "project.merged",
              correlationId: "40000000-0000-4000-8000-000000000099",
              beforeSummary: { state: "active" },
              afterSummary: { mergedIntoProjectId: canonicalId },
              createdAt: new Date("2026-01-02T00:00:00.000Z"),
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };

    const detail = await getProjectDetail(
      {
        userId: "00000000-0000-4000-8000-000000000010",
        role: "member",
      },
      predecessorId,
    );

    expect(detail.id).toBe(canonicalId);
    expect(detail.history).toEqual([
      expect.objectContaining({ action: "project.merged" }),
    ]);
    const resolution = databaseMock.queries.find(({ text }) =>
      text.includes("with recursive seed"),
    );
    expect(resolution?.values).toEqual([predecessorId]);
    const history = databaseMock.queries.find(({ text }) =>
      text.includes("with recursive project_family"),
    );
    expect(history?.values).toEqual([canonicalId]);
    expect(history?.text).toContain(
      "predecessor.merged_into_project_id = family.id",
    );
  });
});
