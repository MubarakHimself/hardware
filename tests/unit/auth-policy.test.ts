import { describe, expect, it } from "vitest";
import {
  ADMIN_ONLY_CAPABILITIES,
  CAPABILITIES,
  MEMBER_CAPABILITIES,
  type AuthenticatedActor,
  type Capability,
} from "../../lib/domain";
import {
  AuthorizationError,
  canManageCollection,
  canManageNote,
  canManagePreference,
  canReadCollection,
  canReadPrivateState,
  hasCapability,
  requireCapability,
  requireCollectionOwnership,
} from "../../lib/auth";

const member: AuthenticatedActor = { userId: "user_member", role: "member" };
const otherMember: AuthenticatedActor = {
  userId: "user_other",
  role: "member",
};
const admin: AuthenticatedActor = { userId: "user_admin", role: "admin" };

describe("role capabilities", () => {
  it("defines a complete, explicit member/admin matrix", () => {
    const memberCapabilities = new Set<Capability>(MEMBER_CAPABILITIES);
    const adminOnlyCapabilities = new Set<Capability>(ADMIN_ONLY_CAPABILITIES);

    for (const capability of CAPABILITIES) {
      expect(hasCapability(admin, capability)).toBe(true);
      expect(hasCapability(member, capability)).toBe(
        memberCapabilities.has(capability),
      );
      expect(
        memberCapabilities.has(capability) ||
          adminOnlyCapabilities.has(capability),
      ).toBe(true);
    }
  });

  it("allows members to browse, import, and manage their personal state", () => {
    expect(hasCapability(member, "catalog:read")).toBe(true);
    expect(hasCapability(member, "imports:create")).toBe(true);
    expect(hasCapability(member, "collections:create")).toBe(true);
    expect(hasCapability(member, "notes:manage-own")).toBe(true);
  });

  it("reserves globally consequential actions for admins", () => {
    expect(hasCapability(member, "channels:manage")).toBe(false);
    expect(hasCapability(member, "repository-candidates:decide")).toBe(false);
    expect(hasCapability(member, "projects:merge")).toBe(false);
    expect(hasCapability(admin, "channels:manage")).toBe(true);
    expect(hasCapability(admin, "repository-candidates:decide")).toBe(true);
    expect(hasCapability(admin, "projects:merge")).toBe(true);
  });

  it("fails closed for a missing actor and distinguishes 401 from 403", () => {
    expect(hasCapability(null, "catalog:read")).toBe(false);
    expect(
      hasCapability(
        { userId: "user_invalid", role: "owner" } as never,
        "catalog:read",
      ),
    ).toBe(false);
    expect(() => requireCapability(null, "catalog:read")).toThrowError(
      expect.objectContaining({ status: 401, code: "authentication_required" }),
    );
    expect(() => requireCapability(member, "channels:manage")).toThrowError(
      expect.objectContaining({ status: 403, code: "forbidden" }),
    );
    expect(
      requireCapability(admin, "channels:manage"),
    ).toEqual(admin);
  });
});

describe("collection policy", () => {
  it("lets only the owner read a private collection", () => {
    const collection = { ownerId: member.userId, visibility: "private" as const };
    expect(canReadCollection(member, collection)).toBe(true);
    expect(canReadCollection(otherMember, collection)).toBe(false);
    expect(canReadCollection(admin, collection)).toBe(false);
  });

  it("lets authenticated users read workspace collections", () => {
    const collection = {
      ownerId: member.userId,
      visibility: "workspace" as const,
    };
    expect(canReadCollection(otherMember, collection)).toBe(true);
    expect(canReadCollection(admin, collection)).toBe(true);
    expect(canReadCollection(null, collection)).toBe(false);
  });

  it("never lets the admin role override collection ownership", () => {
    const collection = { ownerId: member.userId };
    expect(canManageCollection(member, collection)).toBe(true);
    expect(canManageCollection(admin, collection)).toBe(false);
    expect(() => requireCollectionOwnership(admin, collection)).toThrow(
      AuthorizationError,
    );
  });
});

describe("private state policy", () => {
  it("keeps notes and preferences private even from admins", () => {
    const resource = { ownerId: member.userId };
    expect(canReadPrivateState(member, resource)).toBe(true);
    expect(canReadPrivateState(otherMember, resource)).toBe(false);
    expect(canReadPrivateState(admin, resource)).toBe(false);
    expect(canManageNote(member, resource)).toBe(true);
    expect(canManageNote(admin, resource)).toBe(false);
    expect(canManagePreference(member, resource)).toBe(true);
    expect(canManagePreference(admin, resource)).toBe(false);
  });
});
