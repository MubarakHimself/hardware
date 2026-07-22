import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://hardware:hardware@127.0.0.1:5432/hardware",
  },
  migrations: {
    prefix: "timestamp",
    table: "__drizzle_migrations",
    schema: "public",
  },
  strict: true,
  verbose: true,
});
