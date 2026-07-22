import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number };
type RecordedQuery = { text: string; values?: unknown[] };

const databaseMock = vi.hoisted(() => {
  const state: {
    queries: RecordedQuery[];
    responder: (text: string, values?: unknown[]) => QueryResult;
  } = {
    queries: [],
    responder: () => ({ rows: [], rowCount: 0 }),
  };
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    state.queries.push({ text, values });
    const result = state.responder(text, values);
    return { rowCount: result.rowCount ?? result.rows.length, ...result };
  });
  const client = { query, release: vi.fn() };
  return {
    state,
    query,
    client,
    pool: { query, connect: vi.fn(async () => client) },
  };
});

const queueMock = vi.hoisted(() => ({
  add: vi.fn(async () => 42),
}));

vi.mock("../../db/index", () => ({ getPool: () => databaseMock.pool }));
vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => ({ mode: "production" }),
}));
vi.mock("../../lib/server/job-queue", () => ({
  addTrackedGraphileJob: queueMock.add,
}));

import { mergeProject } from "../../lib/server/project-mutations";
import { decideRepositoryCandidate } from "../../lib/server/repository-candidates";
import { queueImport } from "../../lib/server/imports";
import { listJobs, queueProjectMetadataRefresh } from "../../lib/server/jobs";

const actor = {
  userId: "00000000-0000-4000-8000-000000000012",
  role: "admin" as const,
};
const correlationId = "00000000-0000-4000-8000-000000000099";
const sourceId = "10000000-0000-4000-8000-000000000001";
const targetId = "10000000-0000-4000-8000-000000000002";
const repositoryId = "20000000-0000-4000-8000-000000000001";

beforeEach(() => {
  databaseMock.state.queries.length = 0;
  databaseMock.query.mockClear();
  databaseMock.pool.connect.mockClear();
  databaseMock.client.release.mockClear();
  queueMock.add.mockClear();
});

describe("transactional server mutations", () => {
  it("merges provenance, personal state, candidates, aliases, and repository ownership atomically", async () => {
    databaseMock.state.responder = (text, values) => {
      if (text.includes("from projects where id::text = $1 or slug = $1")) {
        const id = values?.[0];
        return {
          rows: [
            id === sourceId
              ? {
                  id: sourceId,
                  slug: "source-project",
                  name: "Source Project",
                  state: "active",
                  version: 3,
                  primary_repository_id: repositoryId,
                  primary_url: "https://Source.Example/?utm_source=video",
                  normalized_primary_url: "https://source.example",
                }
              : {
                  id: targetId,
                  slug: "target-project",
                  name: "Target Project",
                  state: "active",
                  version: 7,
                  primary_repository_id: null,
                  primary_url: "https://target.example",
                  normalized_primary_url: "https://target.example",
                },
          ],
        };
      }
      if (text.includes("where id = any($1::uuid[])")) {
        return {
          rows: [
            { id: sourceId, version: 3, state: "active" },
            { id: targetId, version: 7, state: "active" },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };

    await expect(
      mergeProject({
        actor,
        sourceProjectId: sourceId,
        input: {
          targetProjectId: targetId,
          sourceVersion: 3,
          targetVersion: 7,
        },
        correlationId,
      }),
    ).resolves.toEqual({
      sourceProjectId: sourceId,
      targetProjectId: targetId,
      targetVersion: 8,
    });

    const sql = databaseMock.state.queries.map((query) => query.text);
    expect(sql[0].trim()).toBe("begin");
    expect(sql.at(-1)?.trim()).toBe("commit");
    expect(sql.some((text) => text.includes("update sightings set project_id"))).toBe(true);
    expect(sql.some((text) => text.includes("insert into project_links") && text.includes("select $2::uuid"))).toBe(true);
    expect(sql.some((text) => text.includes("insert into collection_projects"))).toBe(true);
    expect(sql.some((text) => text.includes("insert into project_notes"))).toBe(true);
    expect(sql.some((text) => text.includes("insert into project_preferences"))).toBe(true);
    expect(sql.some((text) => text.includes("delete from repository_candidates source_candidate"))).toBe(true);
    expect(sql.some((text) => text.includes("update repository_candidates") && text.includes("project_id = $2::uuid"))).toBe(true);
    expect(sql.some((text) => text.includes("update repositories set project_id = $2::uuid"))).toBe(true);
    expect(sql.some((text) => text.includes("values ($1::uuid, 'website'") && text.includes("Source Project"))).toBe(false);
    const retainedPrimary = databaseMock.state.queries.find(
      ({ text }) => text.includes("values ($1::uuid, 'website'"),
    );
    expect(retainedPrimary?.values).toEqual([
      targetId,
      "Source Project",
      "https://Source.Example/?utm_source=video",
      "https://source.example",
    ]);
    expect(
      sql.some(
        (text) =>
          text.includes("state = 'merged'") &&
          text.includes("primary_repository_id = null"),
      ),
    ).toBe(true);
  });

  it("approves a candidate with a verified link and one durable immediate refresh job", async () => {
    const candidateId = "30000000-0000-4000-8000-000000000001";
    const projectId = "30000000-0000-4000-8000-000000000002";
    const refreshJobId = "30000000-0000-4000-8000-000000000003";
    databaseMock.state.responder = (text) => {
      if (text.includes("from repository_candidates where id")) {
        return {
          rows: [
            {
              id: candidateId,
              project_id: projectId,
              provider: "github",
              provider_repository_id: "987654321",
              owner: "hardware-labs",
              name: "project",
              canonical_url: "https://github.com/hardware-labs/project",
              state: "pending",
              evidence_hash: "evidence-hash",
              decision_reason: null,
            },
          ],
        };
      }
      if (text.includes("insert into repositories")) {
        return { rows: [{ id: repositoryId }] };
      }
      if (text.includes("insert into ingestion_jobs")) {
        return { rows: [{ id: refreshJobId }] };
      }
      return { rows: [], rowCount: 0 };
    };

    await expect(
      decideRepositoryCandidate({
        actor,
        candidateId,
        decision: { decision: "approve" },
        correlationId,
      }),
    ).resolves.toEqual({
      id: candidateId,
      projectId,
      state: "approved",
      repositoryId,
      refreshJobId,
      reason: null,
    });

    const verifiedLink = databaseMock.state.queries.find(({ text }) =>
      text.includes("insert into project_links"),
    );
    expect(verifiedLink?.text).toContain("verification_state, verified_at");
    expect(verifiedLink?.text).toContain("'verified', now()");
    expect(verifiedLink?.values).toEqual([
      projectId,
      "hardware-labs/project",
      "https://github.com/hardware-labs/project",
    ]);

    const durableJob = databaseMock.state.queries.find(({ text }) =>
      text.includes("insert into ingestion_jobs"),
    );
    expect(durableJob?.values).toEqual([
      `repository:${repositoryId}:approval-refresh`,
      repositoryId,
      actor.userId,
      correlationId,
      JSON.stringify({ repositoryId }),
    ]);
    expect(queueMock.add).toHaveBeenCalledWith(
      databaseMock.client,
      expect.objectContaining({
        task: "repository_refresh",
        jobId: refreshJobId,
        payload: { repositoryId },
      }),
    );
    expect(databaseMock.state.queries.at(-1)?.text.trim()).toBe("commit");
  });

  it("persists the exact strict child payload and returns a stable import job DTO", async () => {
    const jobId = "70000000-0000-4000-8000-000000000001";
    databaseMock.state.responder = (text, values) => {
      if (text.includes("insert into ingestion_jobs")) {
        return {
          rows: [
            {
              id: jobId,
              type: "website_metadata",
              state: "queued",
              idempotencyKey: values?.[1],
              correlationId,
              createdAt: new Date("2026-07-22T00:00:00.000Z"),
            },
          ],
        };
      }
      if (text.includes("graphile_worker.add_job")) {
        return { rows: [{ id: 91 }] };
      }
      return { rows: [], rowCount: 0 };
    };

    const result = await queueImport({
      actor,
      input: {
        kind: "website",
        url: "https://Project.Example/?utm_source=video&b=2&a=1",
      },
      correlationId,
      suppliedIdempotencyKey: "browser-request-1",
    });

    expect(result).toEqual({
      created: true,
      job: {
        id: jobId,
        type: "website_metadata",
        state: "queued",
        idempotencyKey: expect.stringMatching(/^import:[a-f0-9]{64}$/),
        correlationId,
        createdAt: "2026-07-22T00:00:00.000Z",
      },
    });
    const domainJob = databaseMock.state.queries.find(({ text }) =>
      text.includes("insert into ingestion_jobs"),
    );
    expect(domainJob?.values?.[6]).toBe(
      JSON.stringify({
        url: "https://Project.Example/?utm_source=video&b=2&a=1",
      }),
    );
    const graphileJob = databaseMock.state.queries.find(({ text }) =>
      text.includes("graphile_worker.add_job"),
    );
    expect(JSON.parse(String(graphileJob?.values?.[1]))).toEqual({
      jobId,
      correlationId,
      url: "https://Project.Example/?utm_source=video&b=2&a=1",
    });
  });

  it("reuses an hourly project refresh job and enqueues Graphile only once", async () => {
    const projectId = "80000000-0000-4000-8000-000000000001";
    const jobId = "80000000-0000-4000-8000-000000000002";
    const createdAt = new Date("2026-07-22T12:00:00.000Z");
    let inserts = 0;
    const job = {
      id: jobId,
      type: "website_metadata",
      state: "queued",
      scopeType: "project",
      scopeId: projectId,
      requestedByUserId: actor.userId,
      attempts: 0,
      maxAttempts: 3,
      totalItems: 0,
      completedItems: 0,
      warningCount: 0,
      failureCount: 0,
      safeErrorCode: null,
      safeErrorSummary: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
    };
    databaseMock.state.responder = (text) => {
      if (text.includes("from projects p") && text.includes("for update")) {
        return {
          rows: [
            {
              id: projectId,
              primaryUrl: "https://project.example/?utm_source=video",
              repositoryId: null,
            },
          ],
        };
      }
      if (text.includes("insert into ingestion_jobs")) {
        inserts += 1;
        return inserts === 1
          ? { rows: [job] }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("from ingestion_jobs where idempotency_key")) {
        return { rows: [job] };
      }
      return { rows: [], rowCount: 0 };
    };

    const first = await queueProjectMetadataRefresh({
      actor,
      projectId,
      correlationId,
    });
    const second = await queueProjectMetadataRefresh({
      actor,
      projectId,
      correlationId,
    });

    expect(first.jobs).toHaveLength(1);
    expect(second.jobs).toEqual(first.jobs);
    expect(queueMock.add).toHaveBeenCalledTimes(1);
    const refreshInserts = databaseMock.state.queries.filter(({ text }) =>
      text.includes("insert into ingestion_jobs"),
    );
    expect(refreshInserts).toHaveLength(2);
    expect(refreshInserts[0]?.text).toContain(
      "on conflict (idempotency_key) do nothing",
    );
    expect(refreshInserts[0]?.values?.[1]).toMatch(
      /^project:80000000-0000-4000-8000-000000000001:manual-refresh:website_metadata:\d{4}-\d{2}-\d{2}T\d{2}$/,
    );
    const audits = databaseMock.state.queries.filter(({ text }) =>
      text.includes("project.metadata_refresh_queued"),
    );
    expect(audits).toHaveLength(1);
  });

  it("filters job reads by owner for members and exposes safe DTOs", async () => {
    const jobId = "90000000-0000-4000-8000-000000000001";
    databaseMock.state.responder = (text) =>
      text.includes("from ingestion_jobs")
        ? {
            rows: [
              {
                id: jobId,
                type: "website_metadata",
                state: "failed",
                scopeType: "project",
                scopeId: "90000000-0000-4000-8000-000000000002",
                requestedByUserId: actor.userId,
                attempts: 3,
                maxAttempts: 3,
                totalItems: 1,
                completedItems: 0,
                warningCount: 0,
                failureCount: 1,
                safeErrorCode: "WEBSITE_TIMEOUT",
                safeErrorSummary: "The public website did not respond in time.",
                createdAt: new Date("2026-07-22T12:00:00.000Z"),
                updatedAt: new Date("2026-07-22T12:01:00.000Z"),
                startedAt: null,
                finishedAt: new Date("2026-07-22T12:01:00.000Z"),
              },
            ],
          }
        : { rows: [], rowCount: 0 };

    const member = { ...actor, role: "member" as const };
    const jobs = await listJobs({ actor: member, limit: 12 });
    expect(databaseMock.state.queries.at(-1)?.values).toEqual([
      actor.userId,
      false,
      12,
    ]);
    expect(jobs).toEqual([
      expect.objectContaining({
        id: jobId,
        safeErrorCode: "WEBSITE_TIMEOUT",
        safeErrorSummary: "The public website did not respond in time.",
        requestedByMe: true,
        canRetry: false,
      }),
    ]);

    await listJobs({ actor, limit: 20 });
    expect(databaseMock.state.queries.at(-1)?.values).toEqual([
      actor.userId,
      true,
      20,
    ]);
  });
});
