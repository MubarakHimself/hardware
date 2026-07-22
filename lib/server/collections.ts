import "server-only";
import { z } from "zod";
import { getPool } from "../../db/index";
import { canManageCollection, canReadCollection, AuthorizationError } from "../auth";
import type { AuthenticatedActor } from "../domain";
import { getServerConfig } from "./config";
import { createDemoCollection, getDemoState } from "./demo-store";
import { ApiError, conflict, notFound } from "./errors";

export const createCollectionSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1_000).optional(),
    visibility: z.enum(["private", "workspace"]).default("private"),
  })
  .strict();

export const updateCollectionSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(1_000).nullable().optional(),
    visibility: z.enum(["private", "workspace"]).optional(),
    version: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.visibility !== undefined,
    { message: "At least one editable field is required." },
  );

export interface CollectionDto {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  visibility: "private" | "workspace";
  version: number;
  updatedAt: string;
  projectIds: string[];
  projectCount: number;
  canEdit: boolean;
}

function collectionDto(
  collection: Record<string, unknown>,
  actor: AuthenticatedActor,
): CollectionDto {
  const projectIds = Array.isArray(collection.projectIds)
    ? collection.projectIds.map(String)
    : [];
  const updatedAt = collection.updatedAt;
  return {
    id: String(collection.id),
    ownerId: String(collection.ownerId),
    name: String(collection.name),
    description:
      typeof collection.description === "string" && collection.description
        ? collection.description
        : null,
    visibility:
      collection.visibility === "workspace" ? "workspace" : "private",
    version: Number(collection.version),
    updatedAt:
      updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt),
    projectIds,
    projectCount: Number(collection.projectCount ?? projectIds.length),
    canEdit: String(collection.ownerId) === actor.userId,
  };
}

export async function listCollections(actor: AuthenticatedActor) {
  if (getServerConfig().mode === "demo") {
    return getDemoState().collections
      .filter((collection) => canReadCollection(actor, collection))
      .map((collection) => collectionDto({
        id: collection.id,
        ownerId: collection.ownerId,
        name: collection.name,
        description: collection.description,
        visibility: collection.visibility,
        version: collection.version,
        updatedAt: collection.updatedAt,
        projectIds: collection.projectIds,
        projectCount: collection.projectIds.length,
      }, actor));
  }

  const result = await getPool().query(
    `
      select c.id, c.name, c.description, c.visibility, c.version,
        c.owner_user_id as "ownerId", c.updated_at as "updatedAt",
        count(cp.project_id)::int as "projectCount",
        coalesce(array_agg(cp.project_id::text order by cp.position, cp.created_at)
          filter (where cp.project_id is not null), array[]::text[]) as "projectIds"
      from collections c
      left join collection_projects cp on cp.collection_id = c.id
      where c.owner_user_id = $1::uuid or c.visibility = 'workspace'
      group by c.id
      order by (c.owner_user_id = $1::uuid) desc, c.updated_at desc, c.id
    `,
    [actor.userId],
  );
  return result.rows.map((collection) => collectionDto(collection, actor));
}

export async function createCollection(
  actor: AuthenticatedActor,
  input: z.infer<typeof createCollectionSchema>,
  correlationId: string,
) {
  if (getServerConfig().mode === "demo") {
    const collection = createDemoCollection({ ownerId: actor.userId, ...input });
    return collectionDto(collection, actor);
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `insert into collections (owner_user_id, name, description, visibility)
       values ($1::uuid, $2, $3, $4)
       returning id, owner_user_id as "ownerId", name, description, visibility,
                 version, created_at as "createdAt", updated_at as "updatedAt"`,
      [actor.userId, input.name, input.description ?? null, input.visibility],
    );
    const collection = result.rows[0];
    await client.query(
      `insert into audit_events
         (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
       values ($1::uuid, 'collection.created', 'collection', $2, $3::uuid, $4::jsonb)`,
      [
        actor.userId,
        collection.id,
        correlationId,
        JSON.stringify({ visibility: input.visibility, name: input.name }),
      ],
    );
    await client.query("commit");
    return collectionDto(
      { ...collection, projectIds: [], projectCount: 0 },
      actor,
    );
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function mutateCollectionMembership(options: {
  actor: AuthenticatedActor;
  collectionId: string;
  projectId: string;
  operation: "add" | "remove";
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const collection = state.collections.find(
      (item) => item.id === options.collectionId,
    );
    if (!collection) throw notFound("The collection does not exist.");
    if (!canManageCollection(options.actor, collection)) {
      throw new AuthorizationError("forbidden");
    }
    let changed = false;
    if (options.operation === "add") {
      if (!state.projects.some((project) => project.id === options.projectId)) {
        throw notFound("The project does not exist.");
      }
      if (!collection.projectIds.includes(options.projectId)) {
        collection.projectIds.push(options.projectId);
        changed = true;
      }
      const project = state.projects.find((item) => item.id === options.projectId);
      if (project && !project.collectionIds.includes(collection.id)) {
        project.collectionIds.push(collection.id);
      }
    } else {
      const previousLength = collection.projectIds.length;
      collection.projectIds = collection.projectIds.filter(
        (projectId) => projectId !== options.projectId,
      );
      changed = collection.projectIds.length !== previousLength;
      const project = state.projects.find((item) => item.id === options.projectId);
      if (project) {
        project.collectionIds = project.collectionIds.filter(
          (collectionId) => collectionId !== collection.id,
        );
      }
    }
    collection.updatedAt = new Date().toISOString();
    return {
      collectionId: collection.id,
      projectId: options.projectId,
      present: options.operation === "add",
      changed,
    };
  }

  z.string().uuid().parse(options.collectionId);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const collectionResult = await client.query(
      `select owner_user_id as "ownerId", visibility
         from collections where id = $1::uuid for update`,
      [options.collectionId],
    );
    const collection = collectionResult.rows[0];
    if (!collection) throw notFound("The collection does not exist.");
    if (!canManageCollection(options.actor, collection)) {
      throw new AuthorizationError("forbidden");
    }

    let changed = false;
    if (options.operation === "add") {
      const mutation = await client.query(
        `insert into collection_projects (collection_id, project_id, added_by_user_id)
         select $1::uuid, p.id, $2::uuid
           from projects p
          where (p.id::text = $3 or p.slug = $3) and p.state = 'active'
         on conflict (collection_id, project_id) do nothing
         returning project_id`,
        [options.collectionId, options.actor.userId, options.projectId],
      );
      if (mutation.rowCount === 0) {
        const exists = await client.query(
          `select 1 from projects p where (p.id::text = $1 or p.slug = $1) and p.state = 'active'`,
          [options.projectId],
        );
        if (exists.rowCount === 0) throw notFound("The project does not exist.");
      } else {
        changed = true;
      }
    } else {
      const mutation = await client.query(
        `delete from collection_projects cp using projects p
          where cp.collection_id = $1::uuid and cp.project_id = p.id
            and (p.id::text = $2 or p.slug = $2)`,
        [options.collectionId, options.projectId],
      );
      changed = (mutation.rowCount ?? 0) > 0;
    }

    if (changed) {
      await client.query("update collections set updated_at = now() where id = $1::uuid", [options.collectionId]);
      await client.query(
        `insert into audit_events
           (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
         values ($1::uuid, $2, 'collection', $3, $4::uuid, $5::jsonb)`,
        [
          options.actor.userId,
          `collection.project_${options.operation === "add" ? "added" : "removed"}`,
          options.collectionId,
          options.correlationId,
          JSON.stringify({ project: options.projectId }),
        ],
      );
    }
    await client.query("commit");
    return {
      collectionId: options.collectionId,
      projectId: options.projectId,
      present: options.operation === "add",
      changed,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateCollection(options: {
  actor: AuthenticatedActor;
  collectionId: string;
  input: z.infer<typeof updateCollectionSchema>;
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const collection = getDemoState().collections.find(
      (item) => item.id === options.collectionId,
    );
    if (!collection) throw notFound("The collection does not exist.");
    if (!canManageCollection(options.actor, collection)) {
      throw new AuthorizationError("forbidden");
    }
    if (collection.version !== options.input.version) {
      throw new ApiError({
        status: 409,
        code: "version_conflict",
        title: "Conflict",
        detail: "The collection was changed by another request.",
      });
    }
    if (options.input.name !== undefined) collection.name = options.input.name;
    if (options.input.description !== undefined) {
      collection.description = options.input.description ?? "";
    }
    if (options.input.visibility !== undefined) {
      collection.visibility = options.input.visibility;
    }
    collection.version += 1;
    collection.updatedAt = new Date().toISOString();
    return collectionDto(collection, options.actor);
  }

  z.string().uuid().parse(options.collectionId);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const current = await client.query(
      `select owner_user_id as "ownerId", visibility, version
         from collections where id = $1::uuid for update`,
      [options.collectionId],
    );
    if (!current.rows[0]) throw notFound("The collection does not exist.");
    if (!canManageCollection(options.actor, current.rows[0])) {
      throw new AuthorizationError("forbidden");
    }
    if (current.rows[0].version !== options.input.version) {
      throw conflict(
        "version_conflict",
        "The collection was changed by another request.",
      );
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
    if (options.input.visibility !== undefined) {
      sets.push(`visibility = ${parameter(options.input.visibility)}`);
      changedFields.push("visibility");
    }
    values.push(options.collectionId);
    const idParameter = `$${values.length}`;
    const result = await client.query(
      `update collections set ${sets.join(", ")}, version = version + 1, updated_at = now()
        where id = ${idParameter}::uuid
        returning id, owner_user_id as "ownerId", name, description,
                  visibility, version, updated_at as "updatedAt"`,
      values,
    );
    const membership = await client.query(
      `select coalesce(
          array_agg(project_id::text order by position, created_at),
          array[]::text[]
        ) as "projectIds"
         from collection_projects where collection_id = $1::uuid`,
      [options.collectionId],
    );
    await client.query(
      `insert into audit_events
        (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
       values ($1::uuid, 'collection.updated', 'collection', $2, $3::uuid, $4::jsonb)`,
      [options.actor.userId, options.collectionId, options.correlationId, JSON.stringify({ version: options.input.version + 1, changedFields })],
    );
    await client.query("commit");
    return collectionDto(
      {
        ...result.rows[0],
        projectIds: membership.rows[0]?.projectIds ?? [],
      },
      options.actor,
    );
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteCollection(options: {
  actor: AuthenticatedActor;
  collectionId: string;
  version: number;
  correlationId: string;
}) {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const index = state.collections.findIndex((item) => item.id === options.collectionId);
    if (index < 0) throw notFound("The collection does not exist.");
    const collection = state.collections[index];
    if (!canManageCollection(options.actor, collection)) throw new AuthorizationError("forbidden");
    if (collection.version !== options.version) {
      throw conflict("version_conflict", "The collection was changed by another request.");
    }
    state.collections.splice(index, 1);
    for (const project of state.projects) {
      project.collectionIds = project.collectionIds.filter((id) => id !== collection.id);
    }
    return { id: collection.id, deleted: true };
  }

  z.string().uuid().parse(options.collectionId);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const current = await client.query(
      `select owner_user_id as "ownerId", visibility, version
         from collections where id = $1::uuid for update`,
      [options.collectionId],
    );
    if (!current.rows[0]) throw notFound("The collection does not exist.");
    if (!canManageCollection(options.actor, current.rows[0])) throw new AuthorizationError("forbidden");
    if (current.rows[0].version !== options.version) {
      throw conflict("version_conflict", "The collection was changed by another request.");
    }
    await client.query("delete from collections where id = $1::uuid", [options.collectionId]);
    await client.query(
      `insert into audit_events
        (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
       values ($1::uuid, 'collection.deleted', 'collection', $2, $3::uuid, $4::jsonb)`,
      [options.actor.userId, options.collectionId, options.correlationId, JSON.stringify({ deleted: true })],
    );
    await client.query("commit");
    return { id: options.collectionId, deleted: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
