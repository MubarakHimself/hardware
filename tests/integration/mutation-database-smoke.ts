import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { closeDatabase, getPool } from "../../db/index";
import { AuthorizationError } from "../../lib/auth";
import type { AuthenticatedActor } from "../../lib/domain";
import { mutateCollectionMembership } from "../../lib/server/collections";
import { retryJob } from "../../lib/server/jobs";
import { mergeProject, splitProject } from "../../lib/server/project-mutations";
import { decideRepositoryCandidate } from "../../lib/server/repository-candidates";
import { PgIngestionStore } from "../../worker/implementations/pg-store";

const ADMIN_USER_ID = "00000000-0000-4000-8000-00000000a001";
const MEMBER_USER_ID = "00000000-0000-4000-8000-00000000a002";

const runToken = randomUUID().replaceAll("-", "").slice(0, 12);
const ids = {
  candidate: randomUUID(),
  candidateProject: randomUUID(),
  channel: randomUUID(),
  collection: randomUUID(),
  mergeSource: randomUUID(),
  mergeTarget: randomUUID(),
  retryJob: randomUUID(),
  sighting: randomUUID(),
  sourceLink: randomUUID(),
  sourceRepository: randomUUID(),
  video: randomUUID(),
};

const admin: AuthenticatedActor = {
  userId: ADMIN_USER_ID,
  clerkUserId: "user_hardware_mutation_smoke_admin",
  role: "admin",
};
const member: AuthenticatedActor = {
  userId: MEMBER_USER_ID,
  clerkUserId: "user_hardware_mutation_smoke_member",
  role: "member",
};

const urls = {
  candidate: `https://candidate-${runToken}.example`,
  mergeSource: `https://merge-source-${runToken}.example`,
  mergeTarget: `https://merge-target-${runToken}.example`,
  sourceLink: `https://docs-${runToken}.example/guide`,
  sighting: `https://sighting-${runToken}.example/project`,
  split: `https://split-${runToken}.example`,
};

async function seed(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into users (id, clerk_user_id, role)
       values ($1::uuid, $2, 'admin'), ($3::uuid, $4, 'member')
       on conflict (id) do update set role = excluded.role, updated_at = now()`,
      [ADMIN_USER_ID, admin.clerkUserId, MEMBER_USER_ID, member.clerkUserId],
    );
    await client.query(
      `insert into channel_sources
         (id, youtube_channel_id, uploads_playlist_id, handle, title, canonical_url,
          created_by_user_id)
       values ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)`,
      [
        ids.channel,
        `UC${runToken}`,
        `UU${runToken}`,
        `@mutation-smoke-${runToken}`,
        "Mutation smoke channel",
        `https://www.youtube.com/channel/UC${runToken}`,
        ADMIN_USER_ID,
      ],
    );
    await client.query(
      `insert into video_sources
         (id, channel_id, youtube_video_id, title, description, etag, published_at,
          duration_seconds, availability, description_fetched_at,
          youtube_data_expires_at, last_verified_at)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6, now(), 180, 'available',
               now(), now() + interval '30 days', now())`,
      [
        ids.video,
        ids.channel,
        runToken.slice(0, 11),
        "Retention-sensitive video title",
        "Retention-sensitive video description",
        `etag-${runToken}`,
      ],
    );
    await client.query(
      `insert into projects
         (id, slug, name, description, primary_url, normalized_primary_url,
          review_state)
       values
         ($1::uuid, $2, $3, 'Candidate decision contract', $4, $4, 'reviewed'),
         ($5::uuid, $6, $7, 'Merge source contract', $8, $8, 'reviewed'),
         ($9::uuid, $10, $11, 'Merge target contract', $12, $12, 'reviewed')`,
      [
        ids.candidateProject,
        `candidate-${runToken}`,
        `Candidate ${runToken}`,
        urls.candidate,
        ids.mergeSource,
        `merge-source-${runToken}`,
        `Merge source ${runToken}`,
        urls.mergeSource,
        ids.mergeTarget,
        `merge-target-${runToken}`,
        `Merge target ${runToken}`,
        urls.mergeTarget,
      ],
    );
    await client.query(
      `insert into sightings
         (id, project_id, channel_id, video_id, timestamp_seconds, timestamp_label,
          raw_segment, original_url, normalized_url, parser_version)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 37, '0:37', $5, $6,
               $6, 'mutation-smoke/v1')`,
      [
        ids.sighting,
        ids.mergeSource,
        ids.channel,
        ids.video,
        `0:37 Retention-sensitive segment ${urls.sighting}`,
        urls.sighting,
      ],
    );
    await client.query(
      `insert into project_links
         (id, project_id, kind, label, original_url, normalized_url,
          verification_state)
       values ($1::uuid, $2::uuid, 'documentation', 'Source guide', $3, $3,
               'verified')`,
      [ids.sourceLink, ids.mergeSource, urls.sourceLink],
    );
    await client.query(
      `insert into repositories
         (id, project_id, provider, provider_repository_id, owner, name,
          canonical_url)
       values ($1::uuid, $2::uuid, 'github', $3, $4, 'source', $5)`,
      [
        ids.sourceRepository,
        ids.mergeSource,
        `source-${runToken}`,
        `hardware-smoke-${runToken}`,
        `https://github.com/hardware-smoke-${runToken}/source`,
      ],
    );
    await client.query(
      "update projects set primary_repository_id = $1::uuid where id = $2::uuid",
      [ids.sourceRepository, ids.mergeSource],
    );
    await client.query(
      `insert into repository_candidates
         (id, project_id, provider, provider_repository_id, owner, name,
          canonical_url, discovery_method, evidence_hash, evidence,
          score_basis_points)
       values ($1::uuid, $2::uuid, 'github', $3, $4, 'candidate', $5,
               'github_search', $6, $7::jsonb, 9700)`,
      [
        ids.candidate,
        ids.candidateProject,
        `candidate-${runToken}`,
        `hardware-smoke-${runToken}`,
        `https://github.com/hardware-smoke-${runToken}/candidate`,
        `evidence-${runToken}`,
        JSON.stringify({ query: `Candidate ${runToken}`, exactOwner: true }),
      ],
    );
    await client.query(
      `insert into collections (id, owner_user_id, name, visibility)
       values ($1::uuid, $2::uuid, $3, 'private')`,
      [ids.collection, ADMIN_USER_ID, `Mutation contract ${runToken}`],
    );
    await client.query(
      `insert into collection_projects
         (collection_id, project_id, added_by_user_id)
       values ($1::uuid, $2::uuid, $3::uuid)`,
      [ids.collection, ids.mergeSource, ADMIN_USER_ID],
    );
    await client.query(
      `insert into project_notes (owner_user_id, project_id, body)
       values ($1::uuid, $2::uuid, 'Move this private note exactly once')`,
      [ADMIN_USER_ID, ids.mergeSource],
    );
    await client.query(
      `insert into project_preferences (owner_user_id, project_id, is_impressive)
       values ($1::uuid, $2::uuid, true)`,
      [ADMIN_USER_ID, ids.mergeSource],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(pool: Pool): Promise<void> {
  const queued = await pool.query<{ graphile_job_id: string | null }>(
    `select graphile_job_id::text
       from ingestion_jobs
      where requested_by_user_id = $1::uuid and graphile_job_id is not null`,
    [ADMIN_USER_ID],
  );
  const graphileIds = queued.rows
    .map((row) => row.graphile_job_id)
    .filter((value): value is string => Boolean(value));
  if (graphileIds.length > 0) {
    const jobs = await pool.query<{ key: string | null }>(
      "select key from graphile_worker.jobs where id = any($1::bigint[])",
      [graphileIds],
    );
    for (const job of jobs.rows) {
      if (job.key) await pool.query("select graphile_worker.remove_job($1)", [job.key]);
    }
  }

  await pool.query(
    "delete from ingestion_jobs where requested_by_user_id = $1::uuid",
    [ADMIN_USER_ID],
  );
  await pool.query("delete from collections where id = $1::uuid", [ids.collection]);
  await pool.query("delete from sightings where video_id = $1::uuid", [ids.video]);
  await pool.query(
    `update projects set primary_repository_id = null
      where id = any($1::uuid[])`,
    [[ids.candidateProject, ids.mergeSource, ids.mergeTarget]],
  );
  await pool.query("delete from projects where id = $1::uuid", [ids.mergeSource]);
  await pool.query(
    "delete from projects where id = any($1::uuid[])",
    [[ids.candidateProject, ids.mergeTarget]],
  );
  await pool.query("delete from video_sources where id = $1::uuid", [ids.video]);
  await pool.query("delete from channel_sources where id = $1::uuid", [ids.channel]);
}

async function main(): Promise<void> {
  assert.notEqual(
    process.env.DEMO_MODE,
    "true",
    "Mutation database smoke must execute the production code path.",
  );
  const pool = getPool();
  let splitProjectId: string | null = null;
  let failure: unknown;

  try {
    const database = await pool.query<{ name: string }>(
      "select current_database() as name",
    );
    assert.match(
      database.rows[0]?.name ?? "",
      /test/i,
      "Refusing to run destructive mutation smoke outside an isolated test database.",
    );
    await seed(pool);

    const candidateCorrelation = randomUUID();
    const approved = await decideRepositoryCandidate({
      actor: admin,
      candidateId: ids.candidate,
      decision: { decision: "approve" },
      correlationId: candidateCorrelation,
    });
    assert.equal(approved.state, "approved");
    assert.ok(approved.repositoryId);
    assert.ok(approved.refreshJobId);
    const repeatedApproval = await decideRepositoryCandidate({
      actor: admin,
      candidateId: ids.candidate,
      decision: { decision: "approve" },
      correlationId: randomUUID(),
    });
    assert.equal(repeatedApproval.repositoryId, approved.repositoryId);
    assert.equal(repeatedApproval.refreshJobId, approved.refreshJobId);
    const candidateState = await pool.query(
      `select rc.state, rc.reviewed_by_user_id, p.primary_repository_id,
              r.project_id as repository_project_id, j.graphile_job_id,
              (select count(*)::int from audit_events
                where action = 'repository_candidate.approved'
                  and target_id = $1) as audit_count
         from repository_candidates rc
         join projects p on p.id = rc.project_id
         join repositories r on r.id = p.primary_repository_id
         join ingestion_jobs j on j.id = $2::uuid
        where rc.id = $1::uuid`,
      [ids.candidate, approved.refreshJobId],
    );
    assert.equal(candidateState.rows[0]?.state, "approved");
    assert.equal(candidateState.rows[0]?.reviewed_by_user_id, ADMIN_USER_ID);
    assert.equal(candidateState.rows[0]?.repository_project_id, ids.candidateProject);
    assert.ok(candidateState.rows[0]?.graphile_job_id);
    assert.equal(candidateState.rows[0]?.audit_count, 1);

    await assert.rejects(
      mutateCollectionMembership({
        actor: member,
        collectionId: ids.collection,
        projectId: ids.candidateProject,
        operation: "add",
        correlationId: randomUUID(),
      }),
      (error: unknown) =>
        error instanceof AuthorizationError && error.code === "forbidden",
    );
    const unauthorizedMembership = await pool.query(
      `select 1 from collection_projects
        where collection_id = $1::uuid and project_id = $2::uuid`,
      [ids.collection, ids.candidateProject],
    );
    assert.equal(unauthorizedMembership.rowCount, 0);
    const membership = await mutateCollectionMembership({
      actor: admin,
      collectionId: ids.collection,
      projectId: ids.candidateProject,
      operation: "add",
      correlationId: randomUUID(),
    });
    assert.equal(membership.changed, true);

    const merged = await mergeProject({
      actor: admin,
      sourceProjectId: ids.mergeSource,
      input: {
        targetProjectId: ids.mergeTarget,
        sourceVersion: 1,
        targetVersion: 1,
      },
      correlationId: randomUUID(),
    });
    assert.equal(merged.targetVersion, 2);
    const mergeState = await pool.query(
      `select source.state as source_state,
              source.merged_into_project_id,
              target.version as target_version,
              target.primary_repository_id,
              s.project_id as sighting_project_id,
              r.project_id as repository_project_id,
              n.body as note_body,
              pref.is_impressive,
              exists (
                select 1 from collection_projects cp
                 where cp.collection_id = $3::uuid and cp.project_id = target.id
              ) as target_in_collection,
              exists (
                select 1 from collection_projects cp
                 where cp.collection_id = $3::uuid and cp.project_id = source.id
              ) as source_in_collection
         from projects source
         join projects target on target.id = $2::uuid
         join sightings s on s.id = $4::uuid
         join repositories r on r.id = $5::uuid
         join project_notes n
           on n.owner_user_id = $6::uuid and n.project_id = target.id
         join project_preferences pref
           on pref.owner_user_id = $6::uuid and pref.project_id = target.id
        where source.id = $1::uuid`,
      [
        ids.mergeSource,
        ids.mergeTarget,
        ids.collection,
        ids.sighting,
        ids.sourceRepository,
        ADMIN_USER_ID,
      ],
    );
    assert.deepEqual(
      {
        sourceState: mergeState.rows[0]?.source_state,
        mergedInto: mergeState.rows[0]?.merged_into_project_id,
        targetVersion: mergeState.rows[0]?.target_version,
        primaryRepository: mergeState.rows[0]?.primary_repository_id,
        sightingProject: mergeState.rows[0]?.sighting_project_id,
        repositoryProject: mergeState.rows[0]?.repository_project_id,
        note: mergeState.rows[0]?.note_body,
        impressive: mergeState.rows[0]?.is_impressive,
        targetInCollection: mergeState.rows[0]?.target_in_collection,
        sourceInCollection: mergeState.rows[0]?.source_in_collection,
      },
      {
        sourceState: "merged",
        mergedInto: ids.mergeTarget,
        targetVersion: 2,
        primaryRepository: ids.sourceRepository,
        sightingProject: ids.mergeTarget,
        repositoryProject: ids.mergeTarget,
        note: "Move this private note exactly once",
        impressive: true,
        targetInCollection: true,
        sourceInCollection: false,
      },
    );

    const movedLink = await pool.query<{ id: string }>(
      `select id from project_links
        where project_id = $1::uuid and normalized_url = $2`,
      [ids.mergeTarget, urls.sourceLink],
    );
    assert.ok(movedLink.rows[0]?.id);
    const split = await splitProject({
      actor: admin,
      sourceProjectId: ids.mergeTarget,
      input: {
        name: `Split project ${runToken}`,
        primaryUrl: urls.split,
        sourceVersion: 2,
        sightingIds: [ids.sighting],
        linkIds: [movedLink.rows[0].id],
      },
      correlationId: randomUUID(),
    });
    splitProjectId = split.projectId;
    const splitState = await pool.query(
      `select source.version as source_version,
              created.state as created_state,
              created.review_state,
              created.version as created_version,
              s.project_id as sighting_project_id,
              l.project_id as link_project_id
         from projects source
         join projects created on created.id = $2::uuid
         join sightings s on s.id = $3::uuid
         join project_links l on l.id = $4::uuid
        where source.id = $1::uuid`,
      [ids.mergeTarget, split.projectId, ids.sighting, movedLink.rows[0].id],
    );
    assert.deepEqual(
      {
        sourceVersion: splitState.rows[0]?.source_version,
        createdState: splitState.rows[0]?.created_state,
        reviewState: splitState.rows[0]?.review_state,
        createdVersion: splitState.rows[0]?.created_version,
        sightingProject: splitState.rows[0]?.sighting_project_id,
        linkProject: splitState.rows[0]?.link_project_id,
      },
      {
        sourceVersion: 3,
        createdState: "active",
        reviewState: "needs_review",
        createdVersion: 1,
        sightingProject: split.projectId,
        linkProject: split.projectId,
      },
    );

    await pool.query(
      `insert into ingestion_jobs
         (id, type, state, idempotency_key, scope_type, scope_id,
          requested_by_user_id, correlation_id, attempts, max_attempts,
          checkpoint, safe_error_code, safe_error_summary, started_at, finished_at)
       values ($1::uuid, 'repository_refresh', 'failed', $2, 'repository', $3,
               $4::uuid, $5::uuid, 3, 3, $6::jsonb, 'GITHUB_RATE_LIMITED',
               'Provider retry budget was exhausted.', now() - interval '1 minute',
               now())`,
      [
        ids.retryJob,
        `mutation-smoke:${runToken}`,
        approved.repositoryId,
        ADMIN_USER_ID,
        randomUUID(),
        JSON.stringify({ repositoryId: approved.repositoryId }),
      ],
    );
    const retried = await retryJob({
      actor: admin,
      jobId: ids.retryJob,
      correlationId: randomUUID(),
    });
    assert.deepEqual(retried, {
      id: ids.retryJob,
      state: "queued",
      created: true,
    });
    const repeatedRetry = await retryJob({
      actor: admin,
      jobId: ids.retryJob,
      correlationId: randomUUID(),
    });
    assert.equal(repeatedRetry.created, false);
    const retryState = await pool.query(
      `select state, attempts, graphile_job_id, safe_error_code,
              safe_error_summary, started_at, finished_at,
              (select count(*)::int from audit_events
                where action = 'job.retry_queued' and target_id = $1) as audit_count
         from ingestion_jobs where id = $1::uuid`,
      [ids.retryJob],
    );
    assert.equal(retryState.rows[0]?.state, "queued");
    assert.equal(retryState.rows[0]?.attempts, 0);
    assert.ok(retryState.rows[0]?.graphile_job_id);
    assert.equal(retryState.rows[0]?.safe_error_code, null);
    assert.equal(retryState.rows[0]?.safe_error_summary, null);
    assert.equal(retryState.rows[0]?.started_at, null);
    assert.equal(retryState.rows[0]?.finished_at, null);
    assert.equal(retryState.rows[0]?.audit_count, 1);

    const store = new PgIngestionStore(pool);
    await store.markVideoUnavailable(ids.video, randomUUID());
    await store.markVideoUnavailable(ids.video, randomUUID());
    const retentionState = await pool.query(
      `select v.availability, v.title, v.description, v.etag, v.published_at,
              v.duration_seconds, v.description_fetched_at,
              v.youtube_data_expires_at, s.raw_segment, s.last_verified_at,
              (select count(*)::int from audit_events
                where action = 'youtube_source.unavailable' and target_id = $1)
                as audit_count
         from video_sources v
         join sightings s on s.video_id = v.id
        where v.id = $1::uuid`,
      [ids.video],
    );
    assert.equal(retentionState.rows[0]?.availability, "unavailable");
    for (const field of [
      "title",
      "description",
      "etag",
      "published_at",
      "duration_seconds",
      "description_fetched_at",
      "youtube_data_expires_at",
      "raw_segment",
    ]) {
      assert.equal(retentionState.rows[0]?.[field], null, `${field} was not purged`);
    }
    assert.ok(retentionState.rows[0]?.last_verified_at);
    assert.equal(retentionState.rows[0]?.audit_count, 1);

    process.stdout.write(
      "Production mutation SQL smoke passed: candidate decision, ownership, merge, split, retry, and retention.\n",
    );
  } catch (error) {
    failure = error;
  }

  try {
    if (splitProjectId) {
      await pool.query("delete from sightings where project_id = $1::uuid", [
        splitProjectId,
      ]);
      await pool.query("delete from projects where id = $1::uuid", [splitProjectId]);
    }
    await cleanup(pool);
  } catch (error) {
    failure ??= error;
    process.stderr.write("Mutation smoke cleanup did not complete.\n");
  } finally {
    await closeDatabase().catch(() => undefined);
  }

  if (failure) throw failure;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Production mutation database smoke failed: ${error instanceof Error ? (error.stack ?? error.message) : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
