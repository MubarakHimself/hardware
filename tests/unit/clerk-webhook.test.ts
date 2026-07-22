import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const webhookMock = vi.hoisted(() => ({ verify: vi.fn() }));
const databaseMock = vi.hoisted(() => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const state = { tombstoned: false };
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    queries.push({ text, values });
    if (text.includes("insert into users")) {
      if (text.includes("(clerk_user_id, deleted_at)")) {
        if (state.tombstoned) return { rows: [] };
        state.tombstoned = true;
      } else if (state.tombstoned) {
        return { rows: [] };
      }
      return { rows: [{ id: "60000000-0000-4000-8000-000000000001" }] };
    }
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  return {
    queries,
    query,
    state,
    client,
    pool: { connect: vi.fn(async () => client) },
  };
});

vi.mock("@clerk/nextjs/webhooks", () => ({
  verifyWebhook: webhookMock.verify,
}));
vi.mock("../../db/index", () => ({ getPool: () => databaseMock.pool }));
vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => ({
    mode: "production",
    clerkWebhookSigningSecret: "whsec_test",
    adminClerkUserIds: ["user_admin"],
  }),
}));

import { handleClerkWebhook } from "../../lib/server/clerk-webhook";

const correlationId = "60000000-0000-4000-8000-000000000099";

describe("Clerk webhook lifecycle boundary", () => {
  beforeEach(() => {
    webhookMock.verify.mockReset();
    databaseMock.queries.length = 0;
    databaseMock.state.tombstoned = false;
    databaseMock.query.mockClear();
  });

  it("rejects an unverifiable delivery before touching the database", async () => {
    webhookMock.verify.mockRejectedValue(new Error("bad signature"));

    await expect(
      handleClerkWebhook({} as never, correlationId),
    ).rejects.toMatchObject({ code: "invalid_webhook_signature", status: 400 });
    expect(databaseMock.queries).toHaveLength(0);
  });

  it("derives administrator role from the allowlist without copying payload PII into audit", async () => {
    webhookMock.verify.mockResolvedValue({
      type: "user.updated",
      data: {
        id: "user_admin",
        email_addresses: [
          { id: "email_primary", email_address: "Admin@Example.test" },
        ],
        primary_email_address_id: "email_primary",
        first_name: "Alpha",
        last_name: "Administrator",
        username: "alpha-admin",
        image_url: "https://images.example.test/avatar.png",
      },
    });

    await expect(
      handleClerkWebhook({} as never, correlationId),
    ).resolves.toEqual({
      accepted: true,
      ignored: false,
      eventType: "user.updated",
    });

    const userUpsert = databaseMock.queries.find(({ text }) =>
      text.includes("insert into users"),
    );
    expect(userUpsert?.values).toEqual([
      "user_admin",
      "admin@example.test",
      "Alpha Administrator",
      "https://images.example.test/avatar.png",
      "admin",
    ]);
    const audit = databaseMock.queries.find(({ text }) =>
      text.includes("insert into audit_events"),
    );
    expect(audit?.values).toEqual([
      "clerk.user_updated",
      "60000000-0000-4000-8000-000000000001",
      correlationId,
      JSON.stringify({ role: "admin", active: true }),
    ]);
    expect(JSON.stringify(audit?.values)).not.toContain("Admin@Example.test");
    expect(JSON.stringify(audit?.values)).not.toContain("Alpha Administrator");
  });

  it("keeps a delete-first tombstone when an older user update arrives later", async () => {
    webhookMock.verify.mockResolvedValueOnce({
      type: "user.deleted",
      data: { id: "user_deleted" },
    });

    await expect(
      handleClerkWebhook({} as never, correlationId),
    ).resolves.toEqual({
      accepted: true,
      ignored: false,
      eventType: "user.deleted",
    });

    webhookMock.verify.mockResolvedValueOnce({
      type: "user.updated",
      data: {
        id: "user_deleted",
        email_addresses: [
          { id: "email_primary", email_address: "stale@example.test" },
        ],
        primary_email_address_id: "email_primary",
        first_name: "Stale",
        last_name: "Profile",
        username: "stale-profile",
        image_url: "https://images.example.test/stale.png",
      },
    });

    await expect(
      handleClerkWebhook({} as never, correlationId),
    ).resolves.toEqual({
      accepted: true,
      ignored: true,
      eventType: "user.updated",
    });

    const userWrites = databaseMock.queries.filter(({ text }) =>
      text.includes("insert into users"),
    );
    expect(userWrites[0]?.text).toContain("(clerk_user_id, deleted_at)");
    expect(userWrites[1]?.text).toContain("where users.deleted_at is null");
    expect(userWrites[1]?.text).not.toContain("deleted_at = null");
    expect(
      databaseMock.queries.filter(({ text }) =>
        text.includes("insert into audit_events"),
      ),
    ).toHaveLength(1);
  });
});
