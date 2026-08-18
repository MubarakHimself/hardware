import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSchemaVersion,
  requiredRuntimeLayoutEntries,
  type RuntimeLayout,
} from "../../desktop/runtime-layout";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("desktop runtime layout contract", () => {
  it("requires every PostgreSQL executable used by startup and recovery", () => {
    const layout: RuntimeLayout = {
      root: "C:\\runtime",
      serverEntry: "C:\\runtime\\server.js",
      workerEntry: "C:\\runtime\\dist-worker\\index.js",
      migrationEntry: "C:\\runtime\\dist-db\\migrate.js",
      drizzleDirectory: "C:\\runtime\\drizzle",
      postgresRoot: "C:\\postgres",
      postgresBin: "C:\\postgres\\bin",
      postgresShare: "C:\\postgres\\share",
    };

    const names = requiredRuntimeLayoutEntries(layout, "win32").map(
      (entry) => path.win32.basename(entry),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "createdb.exe",
        "dropdb.exe",
        "initdb.exe",
        "pg_ctl.exe",
        "pg_dump.exe",
        "pg_restore.exe",
        "postgres.exe",
        "psql.exe",
      ]),
    );
  });

  it("uses the highest migration index as the backup schema version", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hardware-layout-"));
    temporaryDirectories.push(directory);
    const meta = path.join(directory, "meta");
    await mkdir(meta);
    await writeFile(
      path.join(meta, "_journal.json"),
      JSON.stringify({
        entries: [
          { idx: 7, tag: "20260722174004_channel_batch_import" },
          { idx: 2, tag: "20260722210000_local_identity" },
        ],
      }),
    );

    await expect(readSchemaVersion(directory)).resolves.toBe(
      "20260722174004_channel_batch_import",
    );
  });
});
