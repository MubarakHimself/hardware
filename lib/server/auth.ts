import "server-only";
import { getPool } from "../../db/index";
import { requireCapability } from "../auth";
import type { AuthenticatedActor, Capability } from "../domain";
import { getServerConfig } from "./config";
import { DEFAULT_LOCAL_OWNER_ID, DEMO_ACTOR_ID } from "./local-identity";

export { DEFAULT_LOCAL_OWNER_ID, DEMO_ACTOR_ID } from "./local-identity";

type UserRow = {
  id: string;
  role: "member" | "admin";
};

/**
 * Creates the one durable owner before it is referenced by ownership or audit
 * foreign keys. The fixed primary key and conflict update make concurrent
 * first requests safe and repair a stale role/tombstone from an older install.
 */
export async function ensureLocalOwner(
  userId: string,
  displayName: string,
): Promise<AuthenticatedActor> {
  if (userId !== DEFAULT_LOCAL_OWNER_ID) {
    throw new Error("Personal Local must use the stable local owner ID.");
  }
  const result = await getPool().query<UserRow>(
    `
      insert into users (
        id,
        display_name,
        role,
        last_seen_at,
        deleted_at
      ) values ($1::uuid, $2, 'admin', now(), null)
      on conflict (id) do update
      set display_name = excluded.display_name,
          role = 'admin',
          last_seen_at = now(),
          deleted_at = null,
          updated_at = now()
      returning id::text, role
    `,
    [userId, displayName],
  );
  const owner = result.rows[0];
  if (!owner || owner.role !== "admin") {
    throw new Error("The local owner could not be initialized.");
  }
  return { userId: owner.id, role: "admin" };
}

export async function getRequestActor(): Promise<AuthenticatedActor> {
  const config = getServerConfig();
  if (config.mode === "demo") {
    return {
      userId: DEMO_ACTOR_ID,
      role: config.demoRole,
    };
  }
  return ensureLocalOwner(config.localOwnerId, config.localOwnerName);
}

export async function requireRequestCapability(
  capability: Capability,
): Promise<AuthenticatedActor> {
  const actor = await getRequestActor();
  return requireCapability(actor, capability);
}
