import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../drizzle/20260722220000_personal_ingestion.sql", import.meta.url),
  "utf8",
);

const correctionStart = migration.indexOf(
  'UPDATE "channel_sources" AS "legacy_channel"',
);
const correctionEnd = migration.indexOf(
  "--> statement-breakpoint",
  correctionStart,
);
const correction = migration.slice(correctionStart, correctionEnd);

type MonitoringJobType =
  | "channel_backfill"
  | "channel_poll"
  | "video_ingest"
  | "youtube_revalidate";

interface LegacyChannelFixture {
  name: string;
  enabled: boolean;
  createdByUser: boolean;
  state: "active" | "paused" | "error";
  hasCheckpoint: boolean;
  hasLastSync: boolean;
  hasNextSync: boolean;
  hasLastError: boolean;
  jobs: MonitoringJobType[];
  auditActions: string[];
  expectedEnabled: boolean;
}

const upgradeFixture: LegacyChannelFixture[] = [
  {
    name: "untouched channel seen only through one-off video ingestion",
    enabled: true,
    createdByUser: false,
    state: "active",
    hasCheckpoint: false,
    hasLastSync: false,
    hasNextSync: false,
    hasLastError: false,
    jobs: ["video_ingest"],
    auditActions: ["import.queued"],
    expectedEnabled: false,
  },
  {
    name: "explicit initial channel backfill",
    enabled: true,
    createdByUser: false,
    state: "active",
    hasCheckpoint: false,
    hasLastSync: false,
    hasNextSync: false,
    hasLastError: false,
    jobs: ["channel_backfill"],
    auditActions: [],
    expectedEnabled: true,
  },
  {
    name: "established scheduled channel poll",
    enabled: true,
    createdByUser: false,
    state: "active",
    hasCheckpoint: false,
    hasLastSync: false,
    hasNextSync: false,
    hasLastError: false,
    jobs: ["channel_poll"],
    auditActions: [],
    expectedEnabled: true,
  },
  {
    name: "explicitly added channel whose jobs were pruned",
    enabled: true,
    createdByUser: true,
    state: "active",
    hasCheckpoint: false,
    hasLastSync: false,
    hasNextSync: false,
    hasLastError: false,
    jobs: [],
    auditActions: [],
    expectedEnabled: true,
  },
  {
    name: "channel with durable sync schedule but no retained jobs",
    enabled: true,
    createdByUser: false,
    state: "active",
    hasCheckpoint: false,
    hasLastSync: true,
    hasNextSync: true,
    hasLastError: false,
    jobs: [],
    auditActions: [],
    expectedEnabled: true,
  },
  {
    name: "channel with durable monitoring audit but no retained jobs",
    enabled: true,
    createdByUser: false,
    state: "active",
    hasCheckpoint: false,
    hasLastSync: false,
    hasNextSync: false,
    hasLastError: false,
    jobs: [],
    auditActions: ["channel.added"],
    expectedEnabled: true,
  },
  {
    name: "already disabled provenance channel",
    enabled: false,
    createdByUser: false,
    state: "active",
    hasCheckpoint: false,
    hasLastSync: false,
    hasNextSync: false,
    hasLastError: false,
    jobs: [],
    auditActions: [],
    expectedEnabled: false,
  },
];

function applyUpgradeFixture(channel: LegacyChannelFixture): boolean {
  const hasMonitoringJob = channel.jobs.some(
    (type) => type === "channel_backfill" || type === "channel_poll",
  );
  const hasMonitoringAudit = channel.auditActions.some(
    (action) =>
      action === "channel.added" || action === "channel.sync_queued",
  );
  const isUntouchedProvenance =
    channel.enabled &&
    !channel.createdByUser &&
    channel.state === "active" &&
    !channel.hasCheckpoint &&
    !channel.hasLastSync &&
    !channel.hasNextSync &&
    !channel.hasLastError &&
    !hasMonitoringJob &&
    !hasMonitoringAudit;

  return isUntouchedProvenance ? false : channel.enabled;
}

describe("personal ingestion upgrade migration", () => {
  it("corrects legacy rows after changing the default and before adding v1.1 settings", () => {
    const defaultChange = migration.indexOf(
      'ALTER TABLE "channel_sources" ALTER COLUMN "enabled" SET DEFAULT false',
    );
    const settingsAddition = migration.indexOf(
      'ALTER TABLE "channel_sources" ADD COLUMN "sync_frequency"',
    );

    expect(correctionStart).toBeGreaterThan(defaultChange);
    expect(correctionEnd).toBeGreaterThan(correctionStart);
    expect(settingsAddition).toBeGreaterThan(correctionEnd);
  });

  it("uses channel jobs and durable intent as positive monitoring evidence", () => {
    expect(correction).toContain(
      `"monitoring_job"."type" IN ('channel_backfill', 'channel_poll')`,
    );
    expect(correction).toContain(
      `"monitoring_job"."scope_type" = 'channel'`,
    );
    expect(correction).toContain(
      `"monitoring_job"."scope_id" = "legacy_channel"."id"::text`,
    );
    expect(correction).toContain(
      `"legacy_channel"."created_by_user_id" IS NULL`,
    );
    expect(correction).toContain(
      `"monitoring_event"."action" IN ('channel.added', 'channel.sync_queued')`,
    );
  });

  it("changes only enabled for untouched provenance rows", () => {
    const setClause = correction.match(/\bSET\b([\s\S]*?)\bWHERE\b/u)?.[1];

    expect(setClause?.trim()).toBe('"enabled" = false');
    expect(correction).toContain(
      `"legacy_channel"."checkpoint" = '{}'::jsonb`,
    );
    expect(correction).toContain(
      `"legacy_channel"."last_synced_at" IS NULL`,
    );
    expect(correction).toContain(
      `"legacy_channel"."next_sync_at" IS NULL`,
    );
  });

  it.each(upgradeFixture)("$name", (fixture) => {
    expect(applyUpgradeFixture(fixture)).toBe(fixture.expectedEnabled);
  });
});
