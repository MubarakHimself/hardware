import "server-only";
import type { PoolClient } from "pg";
import type { JobState } from "../domain";

export interface ActiveChannelJob {
  id: string;
  state: Extract<JobState, "queued" | "running">;
}

/** Serialize every producer of channel_backfill/channel_poll work. */
export async function lockChannelJobLane(
  client: PoolClient,
  channelId: string,
): Promise<void> {
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [`hardware:channel:${channelId}`],
  );
}

export async function findActiveChannelJob(
  client: PoolClient,
  channelId: string,
  excludeJobId?: string,
): Promise<ActiveChannelJob | null> {
  const active = await client.query<{ id: string; state: ActiveChannelJob["state"] }>(
    `select id, state
       from ingestion_jobs
      where scope_type = 'channel'
        and scope_id = $1
        and type in ('channel_backfill', 'channel_poll')
        and state in ('queued', 'running')
        and ($2::uuid is null or id <> $2::uuid)
      order by created_at
      limit 1`,
    [channelId, excludeJobId ?? null],
  );
  const row = active.rows[0];
  return row
    ? { id: String(row.id), state: row.state }
    : null;
}
