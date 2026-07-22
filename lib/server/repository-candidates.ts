import "server-only";
import { z } from "zod";
import { getPool } from "../../db/index";
import type { AuthenticatedActor } from "../domain";
import { getServerConfig } from "./config";
import { getDemoState } from "./demo-store";
import { conflict, notFound } from "./errors";
import { addTrackedGraphileJob } from "./job-queue";

export const repositoryDecisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "reject" && !value.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A rejection reason is required.",
      });
    }
  });

export interface RepositoryCandidateDto {
  id: string;
  projectId: string;
  projectName: string;
  repository: string;
  owner: string;
  name: string;
  canonicalUrl: string;
  discoveryMethod: string;
  evidence: string[];
  score: number;
  scoreBasisPoints: number;
  discoveredAt: string;
  state: "pending";
}

export interface RepositoryCandidateDecisionDto {
  id: string;
  projectId: string;
  state: "approved" | "rejected";
  repositoryId: string | null;
  refreshJobId: string | null;
  reason: string | null;
}

function evidenceStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(
    ([key, item]) =>
      `${key}: ${Array.isArray(item) ? item.map(String).join(", ") : String(item)}`,
  );
}

function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function listRepositoryCandidates(): Promise<
  RepositoryCandidateDto[]
> {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    return state.candidates
      .filter((candidate) => !state.candidateDecisions.has(candidate.id))
      .map((candidate) => {
        const [owner = "", name = ""] = candidate.repository.split("/", 2);
        return {
          id: candidate.id,
          projectId: candidate.projectId,
          projectName: candidate.projectName,
          repository: candidate.repository,
          owner,
          name,
          canonicalUrl: `https://github.com/${candidate.repository}`,
          discoveryMethod: "github_search",
          evidence: [...candidate.evidence],
          score: candidate.score,
          scoreBasisPoints: candidate.score * 100,
          discoveredAt: candidate.discoveredAt,
          state: "pending" as const,
        };
      });
  }
  const result = await getPool().query(
    `select rc.id, rc.project_id as "projectId", p.name as "projectName",
      rc.owner, rc.name, rc.canonical_url as "canonicalUrl",
      rc.discovery_method as "discoveryMethod", rc.evidence,
      rc.score_basis_points as "scoreBasisPoints", rc.created_at as "createdAt"
     from repository_candidates rc
     join projects p on p.id = rc.project_id
     where rc.state = 'pending'
     order by rc.score_basis_points desc, rc.created_at, rc.id
     limit 500`,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.projectId),
    projectName: String(row.projectName),
    repository: `${String(row.owner)}/${String(row.name)}`,
    owner: String(row.owner),
    name: String(row.name),
    canonicalUrl: String(row.canonicalUrl),
    discoveryMethod: String(row.discoveryMethod),
    evidence: evidenceStrings(row.evidence),
    score: Number(row.scoreBasisPoints) / 100,
    scoreBasisPoints: Number(row.scoreBasisPoints),
    discoveredAt: isoDate(row.createdAt),
    state: "pending" as const,
  }));
}

export async function decideRepositoryCandidate(options: {
  actor: AuthenticatedActor;
  candidateId: string;
  decision: z.infer<typeof repositoryDecisionSchema>;
  correlationId: string;
}): Promise<RepositoryCandidateDecisionDto> {
  const targetState = options.decision.decision === "approve" ? "approved" : "rejected";
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const candidate = state.candidates.find((item) => item.id === options.candidateId);
    if (!candidate) throw notFound("The repository candidate does not exist.");
    const existing = state.candidateDecisions.get(candidate.id);
    if (existing && existing !== targetState) {
      throw conflict("candidate_already_decided", "This candidate already has a different decision.");
    }
    state.candidateDecisions.set(candidate.id, targetState);
    state.audit.push({
      action: `repository_candidate.${targetState}`,
      targetId: candidate.id,
      actorId: options.actor.userId,
      correlationId: options.correlationId,
    });
    let repositoryId: string | null = null;
    let refreshJobId: string | null = null;
    if (targetState === "approved") {
      repositoryId = `demo-repository-${candidate.id}`;
      refreshJobId = `demo-refresh-${candidate.id}`;
      const project = state.projects.find(
        (item) => item.id === candidate.projectId,
      );
      if (project) {
        project.repositoryState = "verified";
        project.repositoryLabel = candidate.repository;
        project.repositoryUrl = `https://github.com/${candidate.repository}`;
      }
    }
    return {
      id: candidate.id,
      projectId: candidate.projectId,
      state: targetState,
      repositoryId,
      refreshJobId,
      reason: options.decision.reason ?? null,
    };
  }

  z.string().uuid().parse(options.candidateId);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `select id, project_id, provider, provider_repository_id, owner, name,
              canonical_url, state, evidence_hash, decision_reason
         from repository_candidates where id = $1::uuid for update`,
      [options.candidateId],
    );
    const candidate = result.rows[0];
    if (!candidate) throw notFound("The repository candidate does not exist.");
    if (candidate.state !== "pending") {
      if (candidate.state === targetState) {
        const attached =
          targetState === "approved"
            ? await client.query(
                `select p.primary_repository_id as "repositoryId",
                        j.id as "refreshJobId"
                   from projects p
                   left join ingestion_jobs j
                     on j.idempotency_key =
                        ('repository:' || p.primary_repository_id::text || ':approval-refresh')
                  where p.id = $1::uuid
                  order by j.created_at desc nulls last
                  limit 1`,
                [candidate.project_id],
              )
            : { rows: [] };
        await client.query("commit");
        return {
          id: String(candidate.id),
          projectId: String(candidate.project_id),
          state: candidate.state,
          repositoryId: attached.rows[0]?.repositoryId
            ? String(attached.rows[0].repositoryId)
            : null,
          refreshJobId: attached.rows[0]?.refreshJobId
            ? String(attached.rows[0].refreshJobId)
            : null,
          reason: candidate.decision_reason ?? null,
        };
      }
      throw conflict("candidate_already_decided", "This candidate already has a different decision.");
    }

    let repositoryId: string | null = null;
    let refreshJobId: string | null = null;
    if (targetState === "approved") {
      if (!candidate.provider_repository_id) {
        throw conflict(
          "candidate_identity_incomplete",
          "Refresh the candidate before approval so its stable GitHub identity is known.",
        );
      }
      const existingRepository = await client.query(
        `select id, project_id from repositories
          where (provider = $1 and provider_repository_id = $2)
             or (provider = $1 and lower(owner) = lower($3) and lower(name) = lower($4))
          limit 1 for update`,
        [candidate.provider, candidate.provider_repository_id, candidate.owner, candidate.name],
      );
      if (
        existingRepository.rows[0] &&
        existingRepository.rows[0].project_id !== candidate.project_id
      ) {
        throw conflict(
          "repository_attached_elsewhere",
          "This repository is already attached to another project; review a project merge instead.",
        );
      }
      if (existingRepository.rows[0]) {
        repositoryId = existingRepository.rows[0].id;
      } else {
        const repository = await client.query(
          `insert into repositories
             (project_id, provider, provider_repository_id, owner, name, canonical_url)
           values ($1::uuid, $2, $3, $4, $5, $6)
           returning id`,
          [
            candidate.project_id,
            candidate.provider,
            candidate.provider_repository_id,
            candidate.owner,
            candidate.name,
            candidate.canonical_url,
          ],
        );
        repositoryId = repository.rows[0].id;
      }
      await client.query(
        `update projects
            set primary_repository_id = $1::uuid,
                version = version + 1,
                updated_at = now()
          where id = $2::uuid`,
        [repositoryId, candidate.project_id],
      );
      await client.query(
        `insert into project_links
           (project_id, kind, label, original_url, normalized_url,
            verification_state, verified_at)
         values ($1::uuid, 'repository', $2, $3, $3, 'verified', now())
         on conflict (project_id, normalized_url) do update
           set kind = 'repository',
               label = excluded.label,
               verification_state = 'verified',
               verified_at = now(),
               updated_at = now()`,
        [
          candidate.project_id,
          `${candidate.owner}/${candidate.name}`,
          candidate.canonical_url,
        ],
      );

      const refreshKey = `repository:${repositoryId}:approval-refresh`;
      const refreshJob = await client.query(
        `insert into ingestion_jobs
           (type, idempotency_key, scope_type, scope_id,
            requested_by_user_id, correlation_id, checkpoint)
         values
           ('repository_refresh', $1, 'repository', $2, $3::uuid, $4::uuid,
            $5::jsonb)
         on conflict (idempotency_key) do nothing
         returning id`,
        [
          refreshKey,
          repositoryId,
          options.actor.userId,
          options.correlationId,
          JSON.stringify({ repositoryId }),
        ],
      );
      if (refreshJob.rows[0]) {
        refreshJobId = String(refreshJob.rows[0].id);
        const graphileJobId = await addTrackedGraphileJob(client, {
          task: "repository_refresh",
          jobId: refreshJobId,
          correlationId: options.correlationId,
          jobKey: `hardware:${refreshKey}`,
          payload: { repositoryId },
        });
        await client.query(
          "update ingestion_jobs set graphile_job_id = $1 where id = $2::uuid",
          [graphileJobId, refreshJobId],
        );
      } else {
        const existingRefresh = await client.query(
          "select id from ingestion_jobs where idempotency_key = $1",
          [refreshKey],
        );
        refreshJobId = existingRefresh.rows[0]
          ? String(existingRefresh.rows[0].id)
          : null;
      }
    }

    await client.query(
      `update repository_candidates
          set state = $1, decision_reason = $2, reviewed_by_user_id = $3::uuid,
              reviewed_at = now(), updated_at = now()
        where id = $4::uuid`,
      [targetState, options.decision.reason ?? null, options.actor.userId, candidate.id],
    );
    await client.query(
      `insert into audit_events
         (actor_user_id, action, target_type, target_id, correlation_id,
          before_summary, after_summary)
       values ($1::uuid, $2, 'repository_candidate', $3, $4::uuid, $5::jsonb, $6::jsonb)`,
      [
        options.actor.userId,
        `repository_candidate.${targetState}`,
        candidate.id,
        options.correlationId,
        JSON.stringify({ state: "pending", evidenceHash: candidate.evidence_hash }),
        JSON.stringify({
          state: targetState,
          repositoryId,
          refreshJobId,
          reason: options.decision.reason ?? null,
        }),
      ],
    );
    await client.query("commit");
    return {
      id: candidate.id,
      projectId: candidate.project_id,
      state: targetState,
      repositoryId,
      refreshJobId,
      reason: options.decision.reason ?? null,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
