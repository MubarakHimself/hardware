import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { getPool } from "../../db/index";
import type { AuthenticatedActor } from "../domain";
import { normalizeProjectUrl } from "../ingestion";
import { isSafeImportUrlSyntax } from "../validation";
import { getServerConfig } from "./config";
import { getDemoState } from "./demo-store";
import { conflict, notFound } from "./errors";

const publicUrl = z
  .string()
  .trim()
  .max(2_048)
  .refine(
    isSafeImportUrlSyntax,
    "Enter a public HTTP(S) URL without credentials.",
  );

const projectUrl = publicUrl.superRefine((value, context) => {
  const normalized = normalizeProjectUrl(value);
  if (!normalized.ok) {
    context.addIssue({ code: "custom", message: normalized.message });
  }
});

const nullablePublicUrl = z.union([publicUrl, z.null()]).optional();
const nullableProjectUrl = z.union([projectUrl, z.null()]).optional();

export const projectPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(10_000).nullable().optional(),
    primaryUrl: nullableProjectUrl,
    logoUrl: nullablePublicUrl,
    reviewState: z.enum(["unreviewed", "reviewed", "needs_review"]).optional(),
    version: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.primaryUrl !== undefined ||
      value.logoUrl !== undefined ||
      value.reviewState !== undefined,
    { message: "At least one editable field is required." },
  );

const identifier = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const projectMergeSchema = z
  .object({
    targetProjectId: identifier,
    sourceVersion: z.number().int().positive(),
    targetVersion: z.number().int().positive(),
  })
  .strict();

export const projectSplitSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    description: z.string().trim().max(10_000).optional(),
    primaryUrl: nullableProjectUrl,
    sourceVersion: z.number().int().positive(),
    sightingIds: z.array(identifier).min(1).max(500),
    linkIds: z.array(identifier).max(500).default([]),
  })
  .strict();

export function normalizedEditorialProjectUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const normalized = normalizeProjectUrl(value);
  if (!normalized.ok) {
    throw new Error(
      `Validated project URL failed normalization: ${normalized.code}`,
    );
  }
  return normalized.link.canonicalUrl;
}

function slugify(name: string) {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 140);
  return `${base || "project"}-${randomUUID().slice(0, 8)}`;
}

export async function patchProject(options: {
  actor: AuthenticatedActor;
  projectId: string;
  input: z.infer<typeof projectPatchSchema>;
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const project = state.projects.find((item) => item.id === options.projectId);
    if (!project) throw notFound("The project does not exist.");
    const currentVersion = state.projectVersions.get(project.id) ?? 1;
    if (currentVersion !== options.input.version) {
      throw conflict("version_conflict", "The project was changed by another request.");
    }
    if (options.input.name !== undefined) project.name = options.input.name;
    if (options.input.description !== undefined) project.description = options.input.description ?? "";
    if (options.input.primaryUrl !== undefined) {
      project.primaryUrl = options.input.primaryUrl ?? "";
    }
    if (options.input.logoUrl !== undefined) project.logoUrl = options.input.logoUrl;
    if (options.input.reviewState !== undefined) {
      project.reviewState = options.input.reviewState;
      project.isNew = options.input.reviewState !== "reviewed";
    }
    const version = currentVersion + 1;
    state.projectVersions.set(project.id, version);
    return {
      id: project.id,
      slug: project.id,
      name: project.name,
      description: project.description || null,
      primaryUrl: project.primaryUrl || null,
      logoUrl: project.logoUrl ?? null,
      reviewState:
        project.reviewState ?? (project.isNew ? "unreviewed" : "reviewed"),
      version,
    };
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, version from projects
        where (id::text = $1 or slug = $1) and state <> 'merged' for update`,
      [options.projectId],
    );
    if (!before.rows[0]) throw notFound("The project does not exist.");
    if (before.rows[0].version !== options.input.version) {
      throw conflict("version_conflict", "The project was changed by another request.");
    }

    const values: unknown[] = [];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const sets: string[] = [];
    const changedFields: string[] = [];
    if (options.input.name !== undefined) {
      sets.push(`name = ${parameter(options.input.name)}`);
      changedFields.push("name");
    }
    if (options.input.description !== undefined) {
      sets.push(`description = ${parameter(options.input.description)}`);
      changedFields.push("description");
    }
    if (options.input.primaryUrl !== undefined) {
      sets.push(`primary_url = ${parameter(options.input.primaryUrl)}`);
      sets.push(
        `normalized_primary_url = ${parameter(normalizedEditorialProjectUrl(options.input.primaryUrl))}`,
      );
      changedFields.push("primaryUrl");
    }
    if (options.input.logoUrl !== undefined) {
      sets.push(`logo_url = ${parameter(options.input.logoUrl)}`);
      changedFields.push("logoUrl");
    }
    if (options.input.reviewState !== undefined) {
      sets.push(`review_state = ${parameter(options.input.reviewState)}`);
      changedFields.push("reviewState");
    }
    values.push(before.rows[0].id);
    const projectIdParameter = `$${values.length}`;
    const updated = await client.query(
      `update projects set ${sets.join(", ")}, version = version + 1, updated_at = now()
        where id = ${projectIdParameter}::uuid
        returning id, slug, name, description, primary_url as "primaryUrl",
                  logo_url as "logoUrl", review_state as "reviewState", version`,
      values,
    );
    await client.query(
      `insert into audit_events
         (actor_user_id, action, target_type, target_id, correlation_id,
          before_summary, after_summary)
       values ($1::uuid, 'project.edited', 'project', $2, $3::uuid, $4::jsonb, $5::jsonb)`,
      [
        options.actor.userId,
        before.rows[0].id,
        options.correlationId,
        JSON.stringify({ version: options.input.version }),
        JSON.stringify({ version: options.input.version + 1, changedFields }),
      ],
    );
    await client.query("commit");
    return updated.rows[0];
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function resolveProject(client: PoolClient, value: string) {
  const result = await client.query(
    `select id, slug, name, state, version, primary_repository_id,
            primary_url, normalized_primary_url
       from projects where id::text = $1 or slug = $1 limit 1`,
    [value],
  );
  return result.rows[0] ?? null;
}

export async function mergeProject(options: {
  actor: AuthenticatedActor;
  sourceProjectId: string;
  input: z.infer<typeof projectMergeSchema>;
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const source = state.projects.find((item) => item.id === options.sourceProjectId);
    const target = state.projects.find((item) => item.id === options.input.targetProjectId);
    if (!source || !target) throw notFound("One of the projects does not exist.");
    if (source.id === target.id) throw conflict("same_project", "A project cannot be merged into itself.");
    const sourceVersion = state.projectVersions.get(source.id) ?? 1;
    const targetVersion = state.projectVersions.get(target.id) ?? 1;
    if (sourceVersion !== options.input.sourceVersion || targetVersion !== options.input.targetVersion) {
      throw conflict("version_conflict", "One of the projects was changed by another request.");
    }
    if (source.note && target.note) {
      throw conflict("note_merge_conflict", "Resolve overlapping private notes before merging these projects.");
    }
    target.sightings.push(...source.sightings.filter((s) => !target.sightings.some((t) => t.id === s.id)));
    target.sightingCount = target.sightings.length;
    target.collectionIds = [...new Set([...target.collectionIds, ...source.collectionIds])];
    target.note ||= source.note;
    target.isImpressive = Boolean(target.isImpressive || source.isImpressive);
    if (target.repositoryState !== "verified" && source.repositoryState === "verified") {
      target.repositoryState = source.repositoryState;
      target.repositoryUrl = source.repositoryUrl;
      target.repositoryLabel = source.repositoryLabel;
      target.language = source.language;
      target.license = source.license;
      target.stars = source.stars;
      target.topics = [...source.topics];
    }
    if (source.primaryUrl) {
      const normalizedUrl = normalizedEditorialProjectUrl(source.primaryUrl);
      if (normalizedUrl) {
        target.additionalLinks ??= [];
        if (!target.additionalLinks.some((link) => link.normalizedUrl === normalizedUrl)) {
          target.additionalLinks.push({
            id: `merged-primary-${source.id}`,
            kind: "website",
            label: source.name,
            originalUrl: source.primaryUrl,
            normalizedUrl,
            verificationState: "unverified",
            verifiedAt: null,
          });
        }
      }
    }
    for (const candidate of state.candidates) {
      if (candidate.projectId === source.id) candidate.projectId = target.id;
    }
    state.projectRedirects.set(source.id, target.id);
    state.audit.push({
      action: "project.merged",
      targetId: source.id,
      actorId: options.actor.userId,
      correlationId: options.correlationId,
      createdAt: new Date().toISOString(),
    });
    state.projects = state.projects.filter((project) => project.id !== source.id);
    state.projectVersions.set(target.id, targetVersion + 1);
    return { sourceProjectId: source.id, targetProjectId: target.id, targetVersion: targetVersion + 1 };
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const source = await resolveProject(client, options.sourceProjectId);
    const target = await resolveProject(client, options.input.targetProjectId);
    if (!source || !target) throw notFound("One of the projects does not exist.");
    if (source.id === target.id) throw conflict("same_project", "A project cannot be merged into itself.");
    const locked = await client.query(
      `select id, version, state from projects
        where id = any($1::uuid[]) order by id for update`,
      [[source.id, target.id].sort()],
    );
    const lockedSource = locked.rows.find((row) => row.id === source.id);
    const lockedTarget = locked.rows.find((row) => row.id === target.id);
    if (lockedSource?.state !== "active" || lockedTarget?.state !== "active") {
      throw conflict("project_not_active", "Only active projects can be merged.");
    }
    if (
      lockedSource.version !== options.input.sourceVersion ||
      lockedTarget.version !== options.input.targetVersion
    ) {
      throw conflict("version_conflict", "One of the projects was changed by another request.");
    }
    const noteConflict = await client.query(
      `select 1 from project_notes source
        join project_notes target on target.owner_user_id = source.owner_user_id
         and target.project_id = $2::uuid
       where source.project_id = $1::uuid and source.body <> '' and target.body <> '' limit 1`,
      [source.id, target.id],
    );
    if (noteConflict.rowCount) {
      throw conflict("note_merge_conflict", "Resolve overlapping private notes before merging these projects.");
    }

    await client.query("update sightings set project_id = $2::uuid, updated_at = now() where project_id = $1::uuid", [source.id, target.id]);
    await client.query(
      `insert into project_links (project_id, kind, label, original_url, normalized_url, verification_state, verified_at)
       select $2::uuid, kind, label, original_url, normalized_url, verification_state, verified_at
         from project_links where project_id = $1::uuid
       on conflict (project_id, normalized_url) do nothing`,
      [source.id, target.id],
    );
    await client.query("delete from project_links where project_id = $1::uuid", [source.id]);
    await client.query(
      `insert into collection_projects (collection_id, project_id, added_by_user_id, position)
       select collection_id, $2::uuid, added_by_user_id, position
         from collection_projects where project_id = $1::uuid
       on conflict (collection_id, project_id) do nothing`,
      [source.id, target.id],
    );
    await client.query("delete from collection_projects where project_id = $1::uuid", [source.id]);
    await client.query(
      `update project_notes target set body = source.body, version = target.version + 1, updated_at = now()
         from project_notes source
        where source.project_id = $1::uuid and target.project_id = $2::uuid
          and target.owner_user_id = source.owner_user_id and target.body = ''`,
      [source.id, target.id],
    );
    await client.query(
      `insert into project_notes (owner_user_id, project_id, body, version)
       select owner_user_id, $2::uuid, body, version from project_notes source
        where source.project_id = $1::uuid
       on conflict (owner_user_id, project_id) do nothing`,
      [source.id, target.id],
    );
    await client.query("delete from project_notes where project_id = $1::uuid", [source.id]);
    await client.query(
      `insert into project_preferences (owner_user_id, project_id, is_impressive)
       select owner_user_id, $2::uuid, is_impressive from project_preferences
        where project_id = $1::uuid
       on conflict (owner_user_id, project_id) do update
         set is_impressive = project_preferences.is_impressive or excluded.is_impressive,
             updated_at = now()`,
      [source.id, target.id],
    );
    await client.query("delete from project_preferences where project_id = $1::uuid", [source.id]);
    await client.query("update repositories set project_id = $2::uuid, updated_at = now() where project_id = $1::uuid", [source.id, target.id]);
    await client.query(
      `delete from repository_candidates source_candidate
        using repository_candidates target_candidate
       where source_candidate.project_id = $1::uuid
         and target_candidate.project_id = $2::uuid
         and source_candidate.provider = target_candidate.provider
         and lower(source_candidate.owner) = lower(target_candidate.owner)
         and lower(source_candidate.name) = lower(target_candidate.name)
         and source_candidate.evidence_hash = target_candidate.evidence_hash`,
      [source.id, target.id],
    );
    await client.query(
      `update repository_candidates
          set project_id = $2::uuid, updated_at = now()
        where project_id = $1::uuid`,
      [source.id, target.id],
    );
    if (source.primary_url) {
      const normalizedSourceUrl =
        source.normalized_primary_url ??
        normalizedEditorialProjectUrl(source.primary_url);
      await client.query(
        `insert into project_links
           (project_id, kind, label, original_url, normalized_url, verification_state)
         values ($1::uuid, 'website', $2, $3, $4, 'unverified')
         on conflict (project_id, normalized_url) do nothing`,
        [target.id, source.name, source.primary_url, normalizedSourceUrl],
      );
    }
    await client.query(
      `insert into project_aliases (project_id, alias, normalized_alias)
       values ($1::uuid, $2::text, lower($2::text)),
              ($1::uuid, $3::text, lower($3::text))
       on conflict (normalized_alias) do nothing`,
      [target.id, source.name, source.slug],
    );
    await client.query(
      `insert into project_aliases (project_id, alias, normalized_alias)
       select $2::uuid, alias, normalized_alias from project_aliases where project_id = $1::uuid
       on conflict (normalized_alias) do nothing`,
      [source.id, target.id],
    );
    await client.query("delete from project_aliases where project_id = $1::uuid", [source.id]);
    await client.query(
      `update projects set primary_repository_id = coalesce(primary_repository_id, $2::uuid),
          version = version + 1, updated_at = now() where id = $1::uuid`,
      [target.id, source.primary_repository_id],
    );
    await client.query(
      `update projects set state = 'merged', merged_into_project_id = $2::uuid,
          primary_repository_id = null,
          version = version + 1, updated_at = now() where id = $1::uuid`,
      [source.id, target.id],
    );
    await client.query(
      `insert into audit_events
        (actor_user_id, action, target_type, target_id, correlation_id, before_summary, after_summary)
       values ($1::uuid, 'project.merged', 'project', $2, $3::uuid, $4::jsonb, $5::jsonb)`,
      [
        options.actor.userId,
        source.id,
        options.correlationId,
        JSON.stringify({ state: "active", version: options.input.sourceVersion }),
        JSON.stringify({ state: "merged", mergedIntoProjectId: target.id }),
      ],
    );
    await client.query("commit");
    return { sourceProjectId: source.id, targetProjectId: target.id, targetVersion: options.input.targetVersion + 1 };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function splitProject(options: {
  actor: AuthenticatedActor;
  sourceProjectId: string;
  input: z.infer<typeof projectSplitSchema>;
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const source = state.projects.find((item) => item.id === options.sourceProjectId);
    if (!source) throw notFound("The project does not exist.");
    const currentVersion = state.projectVersions.get(source.id) ?? 1;
    if (currentVersion !== options.input.sourceVersion) throw conflict("version_conflict", "The project was changed by another request.");
    const moved = source.sightings.filter((sighting) => options.input.sightingIds.includes(sighting.id));
    if (moved.length !== options.input.sightingIds.length) throw notFound("One or more sightings do not belong to the project.");
    source.sightings = source.sightings.filter((sighting) => !options.input.sightingIds.includes(sighting.id));
    source.sightingCount = source.sightings.length;
    const id = slugify(options.input.name);
    const created = {
      ...source,
      id,
      name: options.input.name,
      description: options.input.description ?? "",
      primaryUrl: options.input.primaryUrl ?? moved[0].originalUrl,
      sightings: moved,
      sightingCount: moved.length,
      collectionIds: [],
      note: undefined,
      isImpressive: false,
      isNew: true,
    };
    state.projects.push(created);
    state.projectVersions.set(source.id, currentVersion + 1);
    state.projectVersions.set(id, 1);
    return { sourceProjectId: source.id, projectId: id, sourceVersion: currentVersion + 1 };
  }

  for (const value of [...options.input.sightingIds, ...options.input.linkIds]) {
    z.string().uuid().parse(value);
  }
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const sourceResult = await client.query(
      `select id, version, state from projects
        where (id::text = $1 or slug = $1) for update`,
      [options.sourceProjectId],
    );
    const source = sourceResult.rows[0];
    if (!source) throw notFound("The project does not exist.");
    if (source.state !== "active") throw conflict("project_not_active", "Only an active project can be split.");
    if (source.version !== options.input.sourceVersion) throw conflict("version_conflict", "The project was changed by another request.");
    const sightings = await client.query(
      `select id, original_url from sightings
        where project_id = $1::uuid and id = any($2::uuid[]) for update`,
      [source.id, options.input.sightingIds],
    );
    if (sightings.rowCount !== options.input.sightingIds.length) {
      throw notFound("One or more sightings do not belong to the project.");
    }
    if (options.input.linkIds.length) {
      const links = await client.query(
        `select id from project_links
          where project_id = $1::uuid and id = any($2::uuid[]) for update`,
        [source.id, options.input.linkIds],
      );
      if (links.rowCount !== options.input.linkIds.length) throw notFound("One or more links do not belong to the project.");
    }
    const primaryUrl = options.input.primaryUrl ?? sightings.rows[0].original_url;
    const created = await client.query(
      `insert into projects
         (slug, name, description, primary_url, normalized_primary_url, review_state)
       values ($1, $2, $3, $4, $5, 'needs_review') returning id, slug, name, version`,
      [
        slugify(options.input.name),
        options.input.name,
        options.input.description ?? null,
        primaryUrl,
        normalizedEditorialProjectUrl(primaryUrl),
      ],
    );
    const project = created.rows[0];
    await client.query("update sightings set project_id = $1::uuid, updated_at = now() where id = any($2::uuid[])", [project.id, options.input.sightingIds]);
    if (options.input.linkIds.length) {
      await client.query("update project_links set project_id = $1::uuid, updated_at = now() where id = any($2::uuid[])", [project.id, options.input.linkIds]);
    }
    await client.query("update projects set version = version + 1, updated_at = now() where id = $1::uuid", [source.id]);
    await client.query(
      `insert into audit_events
        (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
       values ($1::uuid, 'project.split', 'project', $2, $3::uuid, $4::jsonb)`,
      [options.actor.userId, source.id, options.correlationId, JSON.stringify({ projectId: project.id, sightingCount: options.input.sightingIds.length, linkCount: options.input.linkIds.length })],
    );
    await client.query("commit");
    return { sourceProjectId: source.id, projectId: project.id, sourceVersion: options.input.sourceVersion + 1 };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
