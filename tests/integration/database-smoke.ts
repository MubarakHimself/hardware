import { Client } from "pg";

const expectedTables = [
  "users",
  "channel_sources",
  "video_sources",
  "projects",
  "project_aliases",
  "project_links",
  "sightings",
  "repositories",
  "repository_candidates",
  "collections",
  "collection_projects",
  "project_notes",
  "project_preferences",
  "ingestion_jobs",
  "ingestion_events",
  "audit_events",
  "worker_heartbeats",
] as const;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tables = await client.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const actualTables = new Set(tables.rows.map((row) => row.table_name));
    const missingTables = expectedTables.filter((table) => !actualTables.has(table));
    if (missingTables.length > 0) {
      throw new Error(`Missing application tables: ${missingTables.join(", ")}`);
    }

    const extension = await client.query(
      "select 1 from pg_extension where extname = 'pg_trgm'",
    );
    if (extension.rowCount !== 1) throw new Error("pg_trgm is not installed.");

    const workerApi = await client.query(
      `select 1
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'graphile_worker' and p.proname = 'add_job'`,
    );
    if (!workerApi.rowCount) {
      throw new Error("Graphile Worker migrations did not install add_job.");
    }

    const auditTriggers = await client.query<{ trigger_name: string }>(
      `select trigger_name
         from information_schema.triggers
        where event_object_schema = 'public'
          and event_object_table = 'audit_events'`,
    );
    const triggerNames = new Set(
      auditTriggers.rows.map((row) => row.trigger_name),
    );
    for (const expected of [
      "audit_events_prevent_update",
      "audit_events_prevent_delete",
    ]) {
      if (!triggerNames.has(expected)) {
        throw new Error(`Missing append-only audit trigger: ${expected}`);
      }
    }

    process.stdout.write(
      `${JSON.stringify({ event: "database_smoke_passed", tables: expectedTables.length })}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(
    `${JSON.stringify({ event: "database_smoke_failed", errorName })}\n`,
  );
  process.exitCode = 1;
});
