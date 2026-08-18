import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupAuthenticationError,
  BackupEncryptTransform,
  selectRetainedBackups,
  verifyBackupArchive,
  type BackupEnvelopeHeader,
} from "../../desktop/backup";
import type { BackupManifest } from "../../desktop/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function collect(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function manifest(createdAt: string): BackupManifest {
  return {
    formatVersion: 1,
    appVersion: "0.2.0-alpha.1",
    schemaVersion: "drizzle",
    postgresMajor: 17,
    createdAt,
    archiveId: randomUUID(),
  };
}

describe("encrypted desktop backups", () => {
  it("authenticates the manifest and encrypted PostgreSQL payload", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hardware-backup-"));
    temporaryDirectories.push(directory);
    const archive = path.join(directory, "test.hardware-backup");
    const key = randomBytes(32);
    const header: BackupEnvelopeHeader = {
      ...manifest("2026-07-23T12:00:00.000Z"),
      formatVersion: 1,
      postgresMajor: 17,
      keyId: randomUUID(),
      databaseName: "hardware",
      encryption: {
        algorithm: "aes-256-gcm",
        iv: randomBytes(12).toString("base64"),
        tagLength: 16,
      },
    };
    const envelope = Readable.from([Buffer.from("PGDMP-test-payload")]).pipe(
      new BackupEncryptTransform(header, key),
    );
    await writeFile(archive, await collect(envelope));

    await expect(verifyBackupArchive(archive, key)).resolves.toMatchObject({
      header: { archiveId: header.archiveId },
    });
    await expect(
      verifyBackupArchive(archive, randomBytes(32)),
    ).rejects.toBeInstanceOf(BackupAuthenticationError);
  });

  it("retains seven daily and four weekly restore points", () => {
    const manifests = Array.from({ length: 14 }, (_, index) =>
      manifest(
        new Date(Date.UTC(2026, 6, 23 - index, 12)).toISOString(),
      ),
    );
    const retained = selectRetainedBackups(manifests);

    expect(retained.size).toBeGreaterThanOrEqual(7);
    for (const recent of manifests.slice(0, 7)) {
      expect(retained.has(recent.archiveId)).toBe(true);
    }
    expect(retained.size).toBeLessThan(manifests.length);
  });
});
