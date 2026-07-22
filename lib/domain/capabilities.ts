import type { UserRole } from "./contracts";

export const CAPABILITIES = [
  "catalog:read",
  "imports:create",
  "collections:create",
  "collections:read-visible",
  "collections:manage-own",
  "notes:manage-own",
  "preferences:manage-own",
  "channels:manage",
  "projects:edit",
  "projects:merge",
  "projects:split",
  "repository-candidates:decide",
  "jobs:retry",
  "audit:read",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const MEMBER_CAPABILITIES = [
  "catalog:read",
  "imports:create",
  "collections:create",
  "collections:read-visible",
  "collections:manage-own",
  "notes:manage-own",
  "preferences:manage-own",
] as const satisfies readonly Capability[];

export const ADMIN_ONLY_CAPABILITIES = [
  "channels:manage",
  "projects:edit",
  "projects:merge",
  "projects:split",
  "repository-candidates:decide",
  "jobs:retry",
  "audit:read",
] as const satisfies readonly Capability[];

const memberCapabilities = new Set<Capability>(MEMBER_CAPABILITIES);
const adminCapabilities = new Set<Capability>([
  ...MEMBER_CAPABILITIES,
  ...ADMIN_ONLY_CAPABILITIES,
]);

const capabilitiesByRole: Readonly<Record<UserRole, ReadonlySet<Capability>>> = {
  member: memberCapabilities,
  admin: adminCapabilities,
};

export function roleHasCapability(
  role: UserRole,
  capability: Capability,
): boolean {
  return capabilitiesByRole[role]?.has(capability) ?? false;
}
