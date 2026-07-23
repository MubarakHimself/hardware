import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  durablePayloadForTask,
  enqueueTrackedJob,
  scheduleOverdueChannelPolls,
} from "../../worker/scheduler";
import { readFileSync } from "node:fs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";

interface QueryCall { text: string; values?: unknown[] }

function schedulerPool() {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.includes("insert into ingestion_jobs")) {
      return { rows: [{ id: JOB_ID, correlation_id: CORRELATION_ID }] };
    }
    if (text.includes("graphile_worker.add_job")) return { rows: [{ id: "42" }] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  return {
    calls,
    client,
    pool: { connect: vi.fn(async () => client) } as unknown as Pick<Pool, "connect">,
  };
}

describe("durable tracked-job payloads", () => {
  it("retains only the safe channel resolver identity and owner", () => {
    const payload = {
      url: "https://www.youtube.com/@googledevelopers",
      requestedByUserId: "77777777-7777-4777-8777-777777777777",
    };
    expect(durablePayloadForTask("channel_resolve", payload)).toEqual(payload);
    expect(() => durablePayloadForTask("channel_resolve", {
      ...payload,
      title: "untrusted provider metadata",
    })).toThrow();
  });

  it("persists the exact safe scope payload in the same transaction as the Graphile job", async () => {
    const fake = schedulerPool();
    const payload = { projectId: PROJECT_ID, url: "https://project.example/research" };

    await expect(enqueueTrackedJob(
      "website_metadata",
      { scopeType: "project", scopeId: PROJECT_ID, payload, queueName: `project:${PROJECT_ID}` },
      "v1:test",
      { pool: fake.pool },
    )).resolves.toBe(true);

    const inserted = fake.calls.find(({ text }) => text.includes("insert into ingestion_jobs"));
    expect(inserted?.text).toContain("checkpoint");
    expect(JSON.parse(String(inserted?.values?.[4]))).toEqual(payload);
    const graphile = fake.calls.find(({ text }) => text.includes("graphile_worker.add_job"));
    expect(JSON.parse(String(graphile?.values?.[1]))).toEqual({
      ...payload,
      jobId: JOB_ID,
      correlationId: CORRELATION_ID,
    });
    expect(fake.calls.map(({ text }) => text.trim())).toEqual([
      "begin",
      expect.stringContaining("insert into ingestion_jobs"),
      expect.stringContaining("graphile_worker.add_job"),
      expect.stringContaining("update ingestion_jobs"),
      "commit",
    ]);

    // retryJob reads this checkpoint and adds only fresh tracking IDs; parsing
    // it again proves the payload remains compatible with the same task.
    expect(durablePayloadForTask("website_metadata", JSON.parse(String(inserted?.values?.[4])))).toEqual(payload);
  });

  it("keeps repository resolution evidence needed by manual retry", () => {
    const payload = {
      projectId: PROJECT_ID,
      repositoryUrl: "https://github.com/acme/tool",
      candidateOnly: true,
      discoveryMethod: "website_ambiguous",
      parentJobId: JOB_ID,
    };
    expect(durablePayloadForTask("repository_resolve", payload)).toEqual(payload);
  });

  it("allows durable lineage on delayed website work", () => {
    const payload = {
      projectId: PROJECT_ID,
      url: "https://project.example",
      parentJobId: JOB_ID,
    };
    expect(durablePayloadForTask("website_metadata", payload)).toEqual(payload);
  });

  it("retains the safe channel parent reference needed for child progress roll-ups", () => {
    const payload = {
      videoSourceId: "44444444-4444-4444-8444-444444444444",
      parentJobId: JOB_ID,
    };
    expect(durablePayloadForTask("video_ingest", payload)).toEqual(payload);
  });

  it("atomically declines a second active channel source job", async () => {
    const calls: QueryCall[] = [];
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes("from ingestion_jobs")) {
        return { rows: [{ id: JOB_ID }] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pick<Pool, "connect">;

    await expect(enqueueTrackedJob(
      "channel_poll",
      {
        scopeType: "channel",
        scopeId: PROJECT_ID,
        payload: { channelSourceId: PROJECT_ID },
        queueName: `channel:${PROJECT_ID}`,
      },
      "v1:later-bucket",
      { pool },
    )).resolves.toBe(false);

    expect(calls.map(({ text }) => text.trim())).toEqual([
      "begin",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("state in ('queued', 'running')"),
      "rollback",
    ]);
    expect(calls.some(({ text }) => text.includes("insert into ingestion_jobs"))).toBe(false);
  });

  it("rejects raw descriptions, unknown fields, credentials, and secret-like URL parameters before opening a transaction", async () => {
    expect(() => durablePayloadForTask("website_metadata", {
      projectId: PROJECT_ID,
      url: "https://project.example",
      description: "raw source description",
    })).toThrow();
    expect(() => durablePayloadForTask("website_metadata", {
      projectId: PROJECT_ID,
      url: "https://user:password@project.example",
    })).toThrow();
    const fake = schedulerPool();
    await expect(enqueueTrackedJob(
      "website_metadata",
      {
        scopeType: "project",
        scopeId: PROJECT_ID,
        payload: { projectId: PROJECT_ID, url: "https://project.example?api_key=do-not-store" },
      },
      "v1:unsafe",
      { pool: fake.pool },
    )).rejects.toThrow();
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });
});

describe("personal channel scheduling", () => {
  it("sweeps only overdue automatic sources and serializes work per channel", async () => {
    const calls: QueryCall[] = [];
    const query = vi.fn(async (queryText: string, values?: unknown[]) => {
      calls.push({ text: queryText, values });
      if (queryText.includes("from channel_sources")) {
        return { rows: [{ id: PROJECT_ID }] };
      }
      if (queryText.includes("insert into ingestion_jobs")) {
        return { rows: [{ id: JOB_ID, correlation_id: CORRELATION_ID }] };
      }
      if (queryText.includes("graphile_worker.add_job")) {
        return { rows: [{ id: "42" }] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      query,
      connect: vi.fn(async () => client),
    } as unknown as Pool;

    await expect(scheduleOverdueChannelPolls(pool)).resolves.toBe(1);

    const selection = calls.find(({ text }) => text.includes("from channel_sources"));
    expect(selection?.text).toContain("state <> 'paused'");
    expect(selection?.text).toContain("sync_frequency <> 'manual'");
    expect(selection?.text).toContain("next_sync_at <= now()");
    expect(selection?.text).not.toContain("state = 'active'");
    const graphile = calls.find(({ text }) => text.includes("graphile_worker.add_job"));
    expect(graphile?.values?.[2]).toBe(`channel:${PROJECT_ID}`);
  });

  it("interleaves due available and unavailable video lanes to prevent starvation", () => {
    const schedulerSource = readFileSync(
      new URL("../../worker/scheduler.ts", import.meta.url),
      "utf8",
    );
    expect(schedulerSource).toContain("partition by availability order by due_at, id");
    expect(schedulerSource).toContain("availability = 'unavailable' and unavailable_recheck_at <= now()");
    expect(schedulerSource).toContain("order by lane_position");
  });
});
