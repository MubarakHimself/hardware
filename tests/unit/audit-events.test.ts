import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const databaseMock = vi.hoisted(() => {
  const query = vi.fn();
  return { query, pool: { query } };
});

vi.mock("../../db/index", () => ({ getPool: () => databaseMock.pool }));
vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => ({ mode: "production" }),
}));

import { listAuditEvents } from "../../lib/server/audit-events";

const actor = {
  userId: "00000000-0000-4000-8000-000000000001",
  role: "admin" as const,
};

describe("personal activity audit", () => {
  beforeEach(() => databaseMock.query.mockReset());

  it("returns the local owner's and system events using only safe operation fields", async () => {
    databaseMock.query.mockResolvedValue({
      rows: [
        {
          id: "42",
          action: "local.update_failed",
          targetType: "local_runtime",
          targetId: "local.update_failed:new-release",
          status: "failed",
          beforeRelease: "stable-release",
          afterRelease: "new-release",
          createdAt: new Date("2026-07-22T12:00:00.000Z"),
          totalCount: 1,
        },
      ],
    });

    await expect(listAuditEvents({ actor, limit: 25 })).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "42",
          status: "failed",
          beforeRelease: "stable-release",
          afterRelease: "new-release",
          createdAt: "2026-07-22T12:00:00.000Z",
        }),
      ],
      nextCursor: null,
      totalCount: 1,
    });
    expect(databaseMock.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /where actor_user_id = \$1::uuid or actor_user_id is null/u,
      ),
      [actor.userId, null, null, 26],
    );
  });

  it("counts owner and system events while excluding every other actor", async () => {
    databaseMock.query.mockResolvedValue({
      rows: [
        {
          id: "45",
          action: "project.unavailable",
          targetType: "project",
          targetId: "project-45",
          status: "succeeded",
          beforeRelease: null,
          afterRelease: null,
          createdAt: new Date("2026-07-22T12:03:00.000Z"),
          totalCount: 2,
        },
      ],
    });

    const page = await listAuditEvents({ actor, limit: 25 });

    expect(page).toMatchObject({
      items: [
        {
          id: "45",
          action: "project.unavailable",
          targetType: "project",
          targetId: "project-45",
          status: "succeeded",
          beforeRelease: null,
          afterRelease: null,
          createdAt: "2026-07-22T12:03:00.000Z",
        },
      ],
      totalCount: 2,
    });
    const [query] = databaseMock.query.mock.calls[0] as [string];
    expect(query).toContain("count(*) over ()::int as \"totalCount\"");
    expect(query).toContain(
      "where actor_user_id = $1::uuid or actor_user_id is null",
    );
    expect(query).not.toMatch(/actor_user_id\s*(?:<>|!=)/u);
  });

  it("drops malformed release values instead of exposing arbitrary summaries", async () => {
    databaseMock.query.mockResolvedValue({
      rows: [
        {
          id: "43",
          action: "project.updated",
          targetType: "project",
          targetId: "project-1",
          status: "unexpected",
          beforeRelease: "contains a space",
          afterRelease: "x".repeat(129),
          createdAt: "2026-07-22T12:01:00.000Z",
          totalCount: 1,
        },
      ],
    });

    const { items: [event] } = await listAuditEvents({ actor, limit: 1 });
    expect(event).toMatchObject({
      status: "info",
      beforeRelease: null,
      afterRelease: null,
    });
  });

  it("uses a stable created-at and id cursor while retaining the true total", async () => {
    databaseMock.query.mockResolvedValue({
      rows: [
        {
          id: "44",
          action: "project.edited",
          targetType: "project",
          targetId: "project-44",
          status: null,
          beforeRelease: null,
          afterRelease: null,
          createdAt: new Date("2026-07-22T12:02:00.000Z"),
          totalCount: 3,
        },
        {
          id: "43",
          action: "project.edited",
          targetType: "project",
          targetId: "project-43",
          status: null,
          beforeRelease: null,
          afterRelease: null,
          createdAt: new Date("2026-07-22T12:01:00.000Z"),
          totalCount: 3,
        },
      ],
    });

    const firstPage = await listAuditEvents({ actor, limit: 1 });
    expect(firstPage.items.map((event) => event.id)).toEqual(["44"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.totalCount).toBe(3);

    databaseMock.query.mockResolvedValue({ rows: [] });
    await listAuditEvents({
      actor,
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(databaseMock.query).toHaveBeenLastCalledWith(
      expect.stringContaining("id < $3::bigint"),
      [actor.userId, "2026-07-22T12:02:00.000Z", "44", 2],
    );
  });

  it("rejects malformed cursors before querying the database", async () => {
    await expect(
      listAuditEvents({ actor, limit: 25, cursor: "not-a-cursor" }),
    ).rejects.toThrow("invalid or expired");
    expect(databaseMock.query).not.toHaveBeenCalled();
  });
});
