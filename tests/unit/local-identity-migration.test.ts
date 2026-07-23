import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../drizzle/20260722210000_local_identity.sql", import.meta.url),
  "utf8",
);

describe("local identity migration", () => {
  it("makes every migrated collection private", () => {
    expect(migration).toMatch(
      /UPDATE "collections"[\s\S]*?"visibility" = 'private'[\s\S]*?OR "visibility" <> 'private'/u,
    );
  });

  it("preserves complete legacy note bodies, including empty-note rows", () => {
    const widenIndex = migration.indexOf(
      'ALTER TABLE "project_notes" ALTER COLUMN "body" TYPE text',
    );
    const mergeIndex = migration.indexOf('INSERT INTO "project_notes"');

    expect(widenIndex).toBeGreaterThan(-1);
    expect(mergeIndex).toBeGreaterThan(widenIndex);
    expect(migration).toContain(
      'string_agg("body", E\'\\n\\n---\\n\\n\' ORDER BY "updated_at" DESC, "owner_user_id")',
    );
    expect(migration).toContain(
      '"project_notes"."body" || E\'\\n\\n---\\n\\n\' || EXCLUDED."body"',
    );
    expect(migration).not.toContain('AND "body" <> \'\'');
    expect(migration).not.toMatch(/left\([\s\S]{0,80}string_agg/u);
  });

  it("resolves collection collisions with deterministic numeric suffixes", () => {
    expect(migration).toContain(
      "suffix_number := duplicate_collection.duplicate_number",
    );
    expect(migration).toContain(
      "suffix_text := ' (' || suffix_number::text || ')'",
    );
    expect(migration).toContain('ORDER BY ranked."name" COLLATE "C"');
    expect(migration).not.toContain('collection."id"::text');
  });
});
