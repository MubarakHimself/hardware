import { access, readFile } from "node:fs/promises";
import path from "node:path";

export interface RuntimeLayout {
  root: string;
  serverEntry: string;
  workerEntry: string;
  migrationEntry: string;
  drizzleDirectory: string;
  postgresRoot: string;
  postgresBin: string;
  postgresShare: string;
}

export interface RuntimeLayoutOptions {
  packaged: boolean;
  resourcesPath: string;
  applicationPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  postgresOverride?: string;
}

export function resolveRuntimeLayout(
  options: RuntimeLayoutOptions,
): RuntimeLayout {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const root = options.packaged
    ? path.join(options.resourcesPath, "runtime")
    : path.join(options.applicationPath, ".next", "standalone");
  const developmentArtifactRoot = options.applicationPath;
  const artifact = (...segments: string[]) =>
    options.packaged
      ? path.join(root, ...segments)
      : path.join(developmentArtifactRoot, ...segments);
  const postgresRoot =
    options.postgresOverride?.trim() ||
    (options.packaged
      ? path.join(options.resourcesPath, "postgres", `${platform}-${arch}`)
      : path.join(
          options.applicationPath,
          ".desktop-runtime",
          "postgres",
          `${platform}-${arch}`,
        ));

  return {
    root,
    serverEntry: path.join(root, "server.js"),
    workerEntry: artifact("dist-worker", "index.js"),
    migrationEntry: artifact("dist-db", "migrate.js"),
    drizzleDirectory: artifact("drizzle"),
    postgresRoot,
    postgresBin: path.join(postgresRoot, "bin"),
    postgresShare: path.join(postgresRoot, "share"),
  };
}

export async function validateRuntimeLayout(
  layout: RuntimeLayout,
): Promise<void> {
  const required = requiredRuntimeLayoutEntries(layout);
  try {
    await Promise.all(required.map((entry) => access(entry)));
  } catch (error) {
    throw new Error(
      "The packaged Hardware runtime is incomplete. Reinstall this release.",
      { cause: error },
    );
  }
}

export function requiredRuntimeLayoutEntries(
  layout: RuntimeLayout,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const executableExtension = platform === "win32" ? ".exe" : "";
  return [
    layout.serverEntry,
    layout.workerEntry,
    layout.migrationEntry,
    layout.drizzleDirectory,
    path.join(layout.postgresBin, `createdb${executableExtension}`),
    path.join(layout.postgresBin, `dropdb${executableExtension}`),
    path.join(layout.postgresBin, `postgres${executableExtension}`),
    path.join(layout.postgresBin, `initdb${executableExtension}`),
    path.join(layout.postgresBin, `pg_ctl${executableExtension}`),
    path.join(layout.postgresBin, `pg_dump${executableExtension}`),
    path.join(layout.postgresBin, `pg_restore${executableExtension}`),
    path.join(layout.postgresBin, `psql${executableExtension}`),
    layout.postgresShare,
  ];
}

export async function readSchemaVersion(
  drizzleDirectory: string,
): Promise<string> {
  const journalPath = path.join(drizzleDirectory, "meta", "_journal.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(journalPath, "utf8"));
  } catch (error) {
    throw new Error("The packaged migration journal is unreadable.", {
      cause: error,
    });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("The packaged migration journal is invalid.");
  }
  const entries = parsed.entries
    .map((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("idx" in entry) ||
        !Number.isSafeInteger(entry.idx) ||
        !("tag" in entry) ||
        typeof entry.tag !== "string" ||
        !/^[a-zA-Z0-9_-]{1,160}$/.test(entry.tag)
      ) {
        throw new Error("The packaged migration journal is invalid.");
      }
      return { idx: entry.idx as number, tag: entry.tag };
    })
    .sort((left, right) => left.idx - right.idx);
  const latest = entries.at(-1);
  if (!latest) {
    throw new Error("The packaged migration journal is empty.");
  }
  return latest.tag;
}

export function postgresExecutable(
  layout: RuntimeLayout,
  name:
    | "createdb"
    | "dropdb"
    | "initdb"
    | "pg_ctl"
    | "pg_dump"
    | "pg_restore"
    | "postgres"
    | "psql",
): string {
  const extension = process.platform === "win32" ? ".exe" : "";
  return path.join(layout.postgresBin, `${name}${extension}`);
}
