import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getPool } from "../../db/index";
import type { AuthenticatedActor, ProjectSearchQuery } from "../../lib/domain";
import { getProjectDetail, listProjects } from "../../lib/server/catalog";
import { listChannels } from "../../lib/server/channels";

const userId = randomUUID();
const channelId = randomUUID();
const videoId = randomUUID();
const projectId = randomUUID();
const suffix = projectId.replaceAll("-", "").slice(0, 12);
const actor: AuthenticatedActor = {
  userId,
  clerkUserId: `user_database_smoke_${suffix}`,
  role: "admin",
};
const query: ProjectSearchQuery = {
  q: "database smoke",
  sort: "relevance",
  view: "cards",
  limit: 10,
};

async function cleanup(): Promise<void> {
  const pool = getPool();
  await pool.query("delete from sightings where video_id = $1::uuid", [videoId]);
  await pool.query("delete from video_sources where id = $1::uuid", [videoId]);
  await pool.query("delete from projects where id = $1::uuid", [projectId]);
  await pool.query("delete from channel_sources where id = $1::uuid", [channelId]);
  await pool.query("delete from users where id = $1::uuid", [userId]);
}

async function main(): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `insert into users (id, clerk_user_id, role)
       values ($1::uuid, $2, 'admin')`,
      [userId, actor.clerkUserId],
    );
    await pool.query(
      `insert into channel_sources
         (id, youtube_channel_id, uploads_playlist_id, handle, title,
          canonical_url, created_by_user_id)
       values ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)`,
      [
        channelId,
        `UC${suffix}`,
        `UU${suffix}`,
        `@database-smoke-${suffix}`,
        "Database smoke channel",
        `https://www.youtube.com/channel/UC${suffix}`,
        userId,
      ],
    );
    await pool.query(
      `insert into video_sources
         (id, channel_id, youtube_video_id, title, availability)
       values ($1::uuid, $2::uuid, $3, $4, 'available')`,
      [videoId, channelId, suffix.slice(0, 11), "Database smoke video"],
    );
    await pool.query(
      `insert into projects
         (id, slug, name, description, primary_url,
          normalized_primary_url, review_state)
       values ($1::uuid, $2, $3, $4, $5, $5, 'reviewed')`,
      [
        projectId,
        `database-smoke-${suffix}`,
        "Database smoke project",
        "Exercises production catalog SQL against PostgreSQL.",
        `https://database-smoke-${suffix}.example`,
      ],
    );
    await pool.query(
      `insert into sightings
         (project_id, channel_id, video_id, timestamp_seconds,
          timestamp_label, raw_segment, original_url, normalized_url,
          parser_version)
       values ($1::uuid, $2::uuid, $3::uuid, 42, '0:42', $4, $5, $5,
               'database-smoke/v1')`,
      [
        projectId,
        channelId,
        videoId,
        "0:42 Database smoke project",
        `https://database-smoke-${suffix}.example`,
      ],
    );

    const page = await listProjects(actor, query);
    assert.equal(page.projects.some((project) => project.id === projectId), true);
    assert.equal(page.facets.channels.some((channel) => channel.id === channelId), true);

    const detail = await getProjectDetail(actor, projectId);
    assert.equal(detail.id, projectId);
    assert.equal(detail.repositoryState, "none");
    assert.equal(Array.isArray(detail.sightings), true);
    assert.equal((detail.sightings as unknown[]).length, 1);

    const channels = await listChannels();
    assert.equal(channels.some((channel) => channel.id === channelId), true);
    process.stdout.write("Production catalog/channel SQL smoke passed.\n");
  } finally {
    await cleanup().catch(() => undefined);
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Production API database smoke failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
