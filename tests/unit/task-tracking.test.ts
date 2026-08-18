import type { JobHelpers, Task } from "graphile-worker";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMock = vi.hoisted(() => {
  const updates: Array<Record<string, unknown>> = [];
  const queries: string[] = [];
  let rollupState: "running" | "succeeded" = "running";
  const db = {
    update: vi.fn(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updates.push(value);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };
  const pool = {
    query: vi.fn(async (text: string) => {
      queries.push(text);
      if (text.includes("with child_stats as")) {
        return {
          rows: [{
            scopeId: "33333333-3333-4333-8333-333333333333",
            state: rollupState,
          }],
        };
      }
      return { rows: [] };
    }),
  };
  return {
    db,
    pool,
    updates,
    queries,
    setRollupState: (state: "running" | "succeeded") => {
      rollupState = state;
    },
  };
});

vi.mock("../../db/index", () => ({
  getDb: () => databaseMock.db,
  getPool: () => databaseMock.pool,
}));
vi.mock("../../worker/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
  safeErrorDetails: () => ({}),
}));

import { createTaskList } from "../../worker/tasks";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_JOB_ID = "22222222-2222-4222-8222-222222222222";
const CORRELATION_ID = "99999999-9999-4999-8999-999999999999";
const helpers = {
  job: { attempts: 1, max_attempts: 3 },
} as JobHelpers;

beforeEach(() => {
  databaseMock.updates.length = 0;
  databaseMock.queries.length = 0;
  databaseMock.db.update.mockClear();
  databaseMock.db.insert.mockClear();
  databaseMock.pool.query.mockClear();
});

describe("tracked channel parent lifecycle", () => {
  it("keeps the parent running after enumeration while a child is active", async () => {
    databaseMock.setRollupState("running");
    const tasks = createTaskList({ channel_poll: vi.fn(async () => undefined) });

    await (tasks.channel_poll as Task)(
      { jobId: PARENT_JOB_ID, correlationId: CORRELATION_ID },
      helpers,
    );

    expect(databaseMock.queries.some((text) => text.includes("with child_stats as"))).toBe(true);
    expect(databaseMock.updates.filter((update) => update.state === "succeeded")).toHaveLength(0);
    expect(databaseMock.updates.some((update) => update.state === "running")).toBe(true);
  });

  it("rolls a parent and source schedule forward when the last child succeeds", async () => {
    databaseMock.setRollupState("succeeded");
    const tasks = createTaskList({ video_ingest: vi.fn(async () => undefined) });

    await (tasks.video_ingest as Task)(
      {
        jobId: JOB_ID,
        parentJobId: PARENT_JOB_ID,
        correlationId: CORRELATION_ID,
      },
      helpers,
    );

    expect(databaseMock.updates.some((update) => update.state === "succeeded")).toBe(true);
    expect(databaseMock.queries.some((text) => text.includes("last_synced_at = now()"))).toBe(true);
  });
});
