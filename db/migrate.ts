import { migrate } from "drizzle-orm/node-postgres/migrator";
import { runMigrations as runGraphileWorkerMigrations } from "graphile-worker";
import { closeDatabase, getDb } from "./index";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");

  await migrate(getDb(), { migrationsFolder: "./drizzle" });
  await runGraphileWorkerMigrations({ connectionString });
}

main()
  .then(async () => {
    await closeDatabase();
  })
  .catch(async (error: unknown) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const errorCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    console.error(
      JSON.stringify({
        level: "error",
        event: "migration_failed",
        errorName,
        errorCode,
      }),
    );
    await closeDatabase().catch(() => undefined);
    process.exitCode = 1;
  });
