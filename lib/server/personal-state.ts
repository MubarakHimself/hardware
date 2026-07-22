import "server-only";
import { z } from "zod";
import { getPool } from "../../db/index";
import type { AuthenticatedActor } from "../domain";
import { getServerConfig } from "./config";
import { getDemoState } from "./demo-store";
import { conflict, notFound } from "./errors";

export const projectNoteSchema = z
  .object({
    body: z.string().max(10_000),
    version: z.number().int().positive().optional(),
  })
  .strict();

export const projectPreferenceSchema = z
  .object({ isImpressive: z.boolean() })
  .strict();

export async function putProjectNote(options: {
  actor: AuthenticatedActor;
  projectId: string;
  input: z.infer<typeof projectNoteSchema>;
}) {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    const project = state.projects.find((item) => item.id === options.projectId);
    if (!project) throw notFound("The project does not exist.");
    const currentVersion = state.noteVersions.get(project.id);
    if (
      options.input.version !== undefined &&
      currentVersion !== options.input.version
    ) {
      throw conflict("version_conflict", "The note was changed by another request.");
    }
    project.note = options.input.body;
    const version = (currentVersion ?? 0) + 1;
    state.noteVersions.set(project.id, version);
    return { projectId: project.id, body: project.note, version };
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const project = await client.query(
      `select id from projects
        where (id::text = $1 or slug = $1) and state <> 'merged'`,
      [options.projectId],
    );
    if (!project.rows[0]) throw notFound("The project does not exist.");
    const projectId = project.rows[0].id;
    const existing = await client.query(
      `select version from project_notes
        where owner_user_id = $1::uuid and project_id = $2::uuid for update`,
      [options.actor.userId, projectId],
    );
    if (
      options.input.version !== undefined &&
      existing.rows[0]?.version !== options.input.version
    ) {
      throw conflict("version_conflict", "The note was changed by another request.");
    }
    const result = existing.rows[0]
      ? await client.query(
          `update project_notes
              set body = $1, version = version + 1, updated_at = now()
            where owner_user_id = $2::uuid and project_id = $3::uuid
            returning project_id as "projectId", body, version`,
          [options.input.body, options.actor.userId, projectId],
        )
      : await client.query(
          `insert into project_notes (owner_user_id, project_id, body)
           values ($1::uuid, $2::uuid, $3)
           returning project_id as "projectId", body, version`,
          [options.actor.userId, projectId, options.input.body],
        );
    await client.query("commit");
    return result.rows[0];
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function putProjectPreference(options: {
  actor: AuthenticatedActor;
  projectId: string;
  input: z.infer<typeof projectPreferenceSchema>;
}) {
  if (getServerConfig().mode === "demo") {
    const project = getDemoState().projects.find((item) => item.id === options.projectId);
    if (!project) throw notFound("The project does not exist.");
    project.isImpressive = options.input.isImpressive;
    return { projectId: project.id, isImpressive: project.isImpressive };
  }

  const result = await getPool().query(
    `insert into project_preferences (owner_user_id, project_id, is_impressive)
     select $1::uuid, p.id, $3
       from projects p where (p.id::text = $2 or p.slug = $2) and p.state <> 'merged'
     on conflict (owner_user_id, project_id) do update
       set is_impressive = excluded.is_impressive, updated_at = now()
     returning project_id as "projectId", is_impressive as "isImpressive"`,
    [options.actor.userId, options.projectId, options.input.isImpressive],
  );
  if (!result.rows[0]) throw notFound("The project does not exist.");
  return result.rows[0];
}
