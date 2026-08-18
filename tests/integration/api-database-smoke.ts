import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getPool } from "../../db/index";
import type { AuthenticatedActor, ProjectSearchQuery } from "../../lib/domain";
import { getProjectDetail, listProjects } from "../../lib/server/catalog";
import { listChannels } from "../../lib/server/channels";
import { listCollections } from "../../lib/server/collections";

const userId = randomUUID();
const foreignUserId = randomUUID();
const channelId = randomUUID();
const videoId = randomUUID();
const projectId = randomUUID();
const ownerCollectionId = randomUUID();
const foreignCollectionId = randomUUID();
const suffix = projectId.replaceAll("-", "").slice(0, 12);
const actor: AuthenticatedActor = {
  userId,
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
  await pool.query("delete from collections where id = any($1::uuid[])", [
    [ownerCollectionId, foreignCollectionId],
  ]);
  await pool.query("delete from channel_sources where id = $1::uuid", [channelId]);
  await pool.query("delete from users where id = any($1::uuid[])", [
    [userId, foreignUserId],
  ]);
}

async function main(): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `insert into users (id, role)
       values ($1::uuid, 'admin'), ($2::uuid, 'admin')`,
      [userId, foreignUserId],
    );
    await pool.query(
      `insert into channel_sources
         (id, youtube_channel_id, uploads_playlist_id, handle, title,
          canonical_url, created_by_user_id, enabled)
       values ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, true)`,
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
    await pool.query(
      `insert into collections (id, owner_user_id, name, visibility)
       values ($1::uuid, $2::uuid, $3, 'private'),
              ($4::uuid, $5::uuid, $6, 'workspace')`,
      [
        ownerCollectionId,
        userId,
        `Owner database smoke ${suffix}`,
        foreignCollectionId,
        foreignUserId,
        `Foreign database smoke ${suffix}`,
      ],
    );
    await pool.query(
      `insert into collection_projects
         (collection_id, project_id, added_by_user_id)
       values ($1::uuid, $3::uuid, $2::uuid),
              ($4::uuid, $3::uuid, $5::uuid)`,
      [
        ownerCollectionId,
        userId,
        projectId,
        foreignCollectionId,
        foreignUserId,
      ],
    );

    const page = await listProjects(actor, query);
    assert.equal(page.projects.some((project) => project.id === projectId), true);
    assert.equal(page.facets.channels.some((channel) => channel.id === channelId), true);
    const project = page.projects.find((item) => item.id === projectId);
    assert.deepEqual(project?.collectionIds, [ownerCollectionId]);
    assert.equal(
      page.facets.collections.some((collection) => collection.id === ownerCollectionId),
      true,
    );
    assert.equal(
      page.facets.collections.some((collection) => collection.id === foreignCollectionId),
      false,
    );

    const foreignFilter = await listProjects(actor, {
      collection: foreignCollectionId,
      sort: "recently_seen",
      view: "cards",
      limit: 10,
    });
    assert.equal(
      foreignFilter.projects.some((item) => item.id === projectId),
      false,
    );

    const collections = await listCollections(actor);
    assert.equal(
      collections.some((collection) => collection.id === ownerCollectionId),
      true,
    );
    assert.equal(
      collections.some((collection) => collection.id === foreignCollectionId),
      false,
    );
    assert.equal(Object.hasOwn(collections[0] ?? {}, "ownerId"), false);
    assert.equal(Object.hasOwn(collections[0] ?? {}, "visibility"), false);
    assert.equal(Object.hasOwn(collections[0] ?? {}, "canEdit"), false);

    const detail = await getProjectDetail(actor, projectId);
    assert.equal(detail.id, projectId);
    assert.equal(detail.repositoryState, "none");
    assert.equal(Array.isArray(detail.sightings), true);
    assert.equal((detail.sightings as unknown[]).length, 1);
    assert.deepEqual(detail.collectionIds, [ownerCollectionId]);

    const channels = await listChannels();
    assert.equal(channels.some((channel) => channel.id === channelId), true);
    process.stdout.write("Persistent catalog/channel SQL smoke passed.\n");
  } finally {
    await cleanup().catch(() => undefined);
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Persistent API database smoke failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
