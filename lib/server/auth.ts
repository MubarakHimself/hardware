import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getPool } from "../../db/index";
import { AuthorizationError, requireCapability } from "../auth";
import type { AuthenticatedActor, Capability } from "../domain";
import { getServerConfig } from "./config";
import { DEMO_ACTOR_ID } from "./demo-identity";

export { DEMO_ACTOR_ID } from "./demo-identity";

type UserRow = {
  id: string;
  role: "member" | "admin";
  deleted_at: Date | null;
};

function limited(value: string | null | undefined, maximum: number) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

async function upsertClerkUser(clerkUserId: string): Promise<AuthenticatedActor> {
  const config = getServerConfig();
  if (config.mode !== "production") {
    throw new AuthorizationError("authentication_required");
  }
  const clerkUser = await currentUser();
  if (!clerkUser || clerkUser.id !== clerkUserId) {
    throw new AuthorizationError("authentication_required");
  }

  const primaryEmail = clerkUser.emailAddresses.find(
    (email) => email.id === clerkUser.primaryEmailAddressId,
  )?.emailAddress;
  const combinedName = [clerkUser.firstName, clerkUser.lastName]
    .filter(Boolean)
    .join(" ");

  const result = await getPool().query<UserRow>(
    `
      insert into users (
        clerk_user_id,
        email,
        display_name,
        avatar_url,
        last_seen_at,
        role
      ) values ($1, $2, $3, $4, now(), $5)
      on conflict (clerk_user_id) do update
      set email = excluded.email,
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url,
          role = excluded.role,
          last_seen_at = now(),
          updated_at = now()
      where users.deleted_at is null
      returning id, role, deleted_at
    `,
    [
      clerkUserId,
      limited(primaryEmail?.toLowerCase(), 320),
      limited(combinedName || clerkUser.username, 160),
      limited(clerkUser.imageUrl, 2_048),
      config.adminClerkUserIds.includes(clerkUserId) ? "admin" : "member",
    ],
  );
  const user = result.rows[0];
  if (!user || user.deleted_at) {
    throw new AuthorizationError("forbidden");
  }

  return { userId: user.id, clerkUserId, role: user.role };
}

export async function getRequestActor(): Promise<AuthenticatedActor> {
  const config = getServerConfig();
  if (config.mode === "demo") {
    return {
      userId: DEMO_ACTOR_ID,
      clerkUserId: "demo_user",
      role: config.demoRole,
    };
  }

  const session = await auth();
  if (!session.userId) {
    throw new AuthorizationError("authentication_required");
  }
  return upsertClerkUser(session.userId);
}

export async function requireRequestCapability(
  capability: Capability,
): Promise<AuthenticatedActor> {
  const actor = await getRequestActor();
  return requireCapability(actor, capability);
}
