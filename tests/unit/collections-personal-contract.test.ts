import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => ({ mode: "demo", demoRole: "admin" }),
}));

import {
  createCollection,
  createCollectionSchema,
  listCollections,
  updateCollectionSchema,
} from "../../lib/server/collections";
import { listProjects } from "../../lib/server/catalog";
import {
  createDemoCollection,
  getDemoState,
  resetDemoState,
} from "../../lib/server/demo-store";
import { DEMO_ACTOR_ID } from "../../lib/server/local-identity";

const actor = { userId: DEMO_ACTOR_ID, role: "admin" as const };

describe("personal collection contract", () => {
  beforeEach(() => resetDemoState());

  it("rejects legacy visibility on create and update", () => {
    expect(createCollectionSchema.safeParse({
      name: "Private collection",
      visibility: "workspace",
    }).success).toBe(false);
    expect(updateCollectionSchema.safeParse({
      version: 1,
      name: "Renamed",
      visibility: "private",
    }).success).toBe(false);
    expect(createCollectionSchema.safeParse({ name: "Private collection" }).success).toBe(true);
    expect(updateCollectionSchema.safeParse({ version: 1, description: null }).success).toBe(true);
  });

  it("returns only the singleton owner's collections without access metadata", async () => {
    const foreign = createDemoCollection({
      ownerId: "00000000-0000-4000-8000-000000000099",
      name: "Foreign legacy collection",
    });
    const project = getDemoState().projects[0];
    foreign.projectIds.push(project.id);
    project.collectionIds.push(foreign.id);

    const collections = await listCollections(actor);
    expect(collections.length).toBeGreaterThan(0);
    expect(collections.some((collection) => collection.name === "Foreign legacy collection")).toBe(false);
    for (const collection of collections) {
      expect(collection).not.toHaveProperty("ownerId");
      expect(collection).not.toHaveProperty("visibility");
      expect(collection).not.toHaveProperty("canEdit");
    }

    const catalog = await listProjects(actor, {
      sort: "recently_seen",
      view: "cards",
      limit: 100,
    });
    expect(catalog.facets.collections.some((collection) => collection.id === foreign.id)).toBe(false);
    expect(
      catalog.projects.find((item) => item.id === project.id)?.collectionIds,
    ).not.toContain(foreign.id);
  });

  it("creates a private internal row without exposing its storage fields", async () => {
    const collection = await createCollection(
      actor,
      { name: "Architecture notes", description: "Personal research" },
      "00000000-0000-4000-8000-000000000098",
    );

    expect(collection).toEqual(expect.objectContaining({
      name: "Architecture notes",
      description: "Personal research",
      projectIds: [],
      projectCount: 0,
    }));
    expect(collection).not.toHaveProperty("ownerId");
    expect(collection).not.toHaveProperty("visibility");
    expect(collection).not.toHaveProperty("canEdit");
  });
});
