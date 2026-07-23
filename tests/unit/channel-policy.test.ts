import { describe, expect, it } from "vitest";
import { calculateNextChannelSyncAt } from "../../lib/domain";

describe("personal channel sync policy", () => {
  const now = new Date("2026-07-22T10:00:00.000Z");

  it("defaults a never-synced automatic source to immediate catch-up", () => {
    expect(calculateNextChannelSyncAt("daily", null, now)?.toISOString())
      .toBe(now.toISOString());
  });

  it("preserves a future daily or weekly due date", () => {
    expect(calculateNextChannelSyncAt(
      "daily",
      new Date("2026-07-22T08:00:00.000Z"),
      now,
    )?.toISOString()).toBe("2026-07-23T08:00:00.000Z");
    expect(calculateNextChannelSyncAt(
      "weekly",
      new Date("2026-07-20T08:00:00.000Z"),
      now,
    )?.toISOString()).toBe("2026-07-27T08:00:00.000Z");
  });

  it("catches up overdue sources immediately and never schedules manual sources", () => {
    expect(calculateNextChannelSyncAt(
      "daily",
      new Date("2026-07-20T08:00:00.000Z"),
      now,
    )?.toISOString()).toBe(now.toISOString());
    expect(calculateNextChannelSyncAt("manual", null, now)).toBeNull();
  });
});
