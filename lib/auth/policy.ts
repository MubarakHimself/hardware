import {
  roleHasCapability,
  type AuthenticatedActor,
  type Capability,
  type CollectionAccessResource,
  type OwnedResource,
} from "../domain";

export class AuthorizationError extends Error {
  readonly code: "authentication_required" | "forbidden";
  readonly status: 401 | 403;

  constructor(code: "authentication_required" | "forbidden") {
    super(
      code === "authentication_required"
        ? "Authentication is required."
        : "You do not have permission to perform this action.",
    );
    this.name = "AuthorizationError";
    this.code = code;
    this.status = code === "authentication_required" ? 401 : 403;
  }
}

export function isAuthenticated(
  actor: AuthenticatedActor | null | undefined,
): actor is AuthenticatedActor {
  return (
    actor !== null &&
    actor !== undefined &&
    typeof actor.userId === "string" &&
    actor.userId.trim().length > 0 &&
    (actor.role === "member" || actor.role === "admin")
  );
}

export function hasCapability(
  actor: AuthenticatedActor | null | undefined,
  capability: Capability,
): boolean {
  return isAuthenticated(actor) && roleHasCapability(actor.role, capability);
}

export function requireAuthenticated(
  actor: AuthenticatedActor | null | undefined,
): AuthenticatedActor {
  if (!isAuthenticated(actor)) {
    throw new AuthorizationError("authentication_required");
  }

  return actor;
}

export function requireCapability(
  actor: AuthenticatedActor | null | undefined,
  capability: Capability,
): AuthenticatedActor {
  const authenticatedActor = requireAuthenticated(actor);
  if (!hasCapability(authenticatedActor, capability)) {
    throw new AuthorizationError("forbidden");
  }

  return authenticatedActor;
}

export function canReadCollection(
  actor: AuthenticatedActor | null | undefined,
  collection: CollectionAccessResource,
): boolean {
  if (
    !isAuthenticated(actor) ||
    !hasCapability(actor, "collections:read-visible")
  ) {
    return false;
  }

  return (
    collection.ownerId === actor.userId || collection.visibility === "workspace"
  );
}

/** Admin status does not override ownership of a member's collection. */
export function canManageCollection(
  actor: AuthenticatedActor | null | undefined,
  collection: OwnedResource,
): boolean {
  return (
    isAuthenticated(actor) &&
    hasCapability(actor, "collections:manage-own") &&
    collection.ownerId === actor.userId
  );
}

/** Notes and preferences are private even from workspace administrators. */
export function canReadPrivateState(
  actor: AuthenticatedActor | null | undefined,
  resource: OwnedResource,
): boolean {
  return isAuthenticated(actor) && resource.ownerId === actor.userId;
}

export function canManageNote(
  actor: AuthenticatedActor | null | undefined,
  note: OwnedResource,
): boolean {
  return (
    isAuthenticated(actor) &&
    hasCapability(actor, "notes:manage-own") &&
    note.ownerId === actor.userId
  );
}

export function canManagePreference(
  actor: AuthenticatedActor | null | undefined,
  preference: OwnedResource,
): boolean {
  return (
    isAuthenticated(actor) &&
    hasCapability(actor, "preferences:manage-own") &&
    preference.ownerId === actor.userId
  );
}

export function requireCollectionRead(
  actor: AuthenticatedActor | null | undefined,
  collection: CollectionAccessResource,
): AuthenticatedActor {
  const authenticatedActor = requireAuthenticated(actor);
  if (!canReadCollection(authenticatedActor, collection)) {
    throw new AuthorizationError("forbidden");
  }
  return authenticatedActor;
}

export function requireCollectionOwnership(
  actor: AuthenticatedActor | null | undefined,
  collection: OwnedResource,
): AuthenticatedActor {
  const authenticatedActor = requireAuthenticated(actor);
  if (!canManageCollection(authenticatedActor, collection)) {
    throw new AuthorizationError("forbidden");
  }
  return authenticatedActor;
}
