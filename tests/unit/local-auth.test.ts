import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const boundary = vi.hoisted(() => ({
  query: vi.fn(),
  config: vi.fn(),
}));

vi.mock("../../db/index", () => ({
  getPool: () => ({ query: boundary.query }),
}));
vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => boundary.config(),
}));

import {
  DEFAULT_LOCAL_OWNER_ID,
  ensureLocalOwner,
  getRequestActor,
} from "../../lib/server/auth";

describe("persistent local identity", () => {
  beforeEach(() => {
    boundary.query.mockReset();
    boundary.config.mockReset();
  });

  it("upserts the stable owner as admin before returning it", async () => {
    boundary.query.mockResolvedValue({
      rows: [{ id: DEFAULT_LOCAL_OWNER_ID, role: "admin" }],
    });

    await expect(
      ensureLocalOwner(DEFAULT_LOCAL_OWNER_ID, "My library"),
    ).resolves.toEqual({ userId: DEFAULT_LOCAL_OWNER_ID, role: "admin" });
    const [sql, values] = boundary.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("on conflict (id) do update");
    expect(sql).toContain("role = 'admin'");
    expect(sql.toLowerCase()).not.toContain("clerk");
    expect(values).toEqual([DEFAULT_LOCAL_OWNER_ID, "My library"]);
  });

  it("cannot initialize a second local owner", async () => {
    await expect(
      ensureLocalOwner(
        "00000000-0000-4000-8000-000000000002",
        "Different owner",
      ),
    ).rejects.toThrow("stable local owner ID");
    expect(boundary.query).not.toHaveBeenCalled();
  });

  it("uses fixture identity only when APP_MODE resolves to demo", async () => {
    boundary.config.mockReturnValue({ mode: "demo", demoRole: "member" });
    await expect(getRequestActor()).resolves.toEqual({
      userId: DEFAULT_LOCAL_OWNER_ID,
      role: "member",
    });
    expect(boundary.query).not.toHaveBeenCalled();
  });
});
