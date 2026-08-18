import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  type ReadStream,
} from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  Transform,
  Writable,
  type TransformCallback,
} from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { DesktopLogger } from "./logger";
import { safeError, silentLogger } from "./logger";
import type { RuntimePaths } from "./paths";
import type { PostgresConnection } from "./postgres";
import { postgresUrl } from "./postgres";
import {
  postgresExecutable,
  type RuntimeLayout,
} from "./runtime-layout";
import type { DesktopSettingsStore } from "./settings";
import type {
  BackupManifest,
  BackupResult,
  NativeOperationProgress,
  RestoreResult,
} from "./types";
import type { CredentialVault } from "./vault";

const MAGIC = Buffer.from("HWBK0001", "ascii");
const PREFIX_BYTES = MAGIC.byteLength + 4;
const AUTH_TAG_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024;
const LEGACY_BACKUP_KEY_VAULT_ENTRY = "backup:key";
const ACTIVE_BACKUP_KEY_ID_ENTRY = "backup:active-key-id";

const envelopeHeaderSchema = z.object({
  formatVersion: z.literal(1),
  appVersion: z.string().min(1).max(160),
  schemaVersion: z.string().min(1).max(160),
  postgresMajor: z.literal(17),
  createdAt: z.string().datetime(),
  archiveId: z.string().uuid(),
  keyId: z.string().uuid(),
  databaseName: z.literal("hardware"),
  encryption: z.object({
    algorithm: z.literal("aes-256-gcm"),
    iv: z.string(),
    tagLength: z.literal(16),
  }),
});

type EnvelopeHeader = z.infer<typeof envelopeHeaderSchema>;
export type BackupEnvelopeHeader = EnvelopeHeader;

const recoveryKeyFileSchema = z.object({
  formatVersion: z.literal(1),
  product: z.literal("Hardware"),
  purpose: z.literal("backup-recovery-key"),
  algorithm: z.literal("aes-256-gcm"),
  key: z.string(),
  keyId: z.string().uuid(),
  exportedAt: z.string().datetime(),
});

interface ParsedEnvelope {
  header: EnvelopeHeader;
  headerBytes: Buffer;
  payloadOffset: number;
  ciphertextEnd: number;
  authTag: Buffer;
  size: number;
}

export interface BackupRestoreHooks {
  migrateStaging(databaseUrl: string): Promise<void>;
  validateStaging(databaseUrl: string): Promise<void>;
  stopConsumers(): Promise<void>;
  startConsumers(): Promise<void>;
  recordRestore?(
    result: { success: boolean; archiveId: string },
  ): Promise<void>;
}

export class NativeOperationBusyError extends Error {
  constructor() {
    super("A backup or restore operation is already active.");
    this.name = "NativeOperationBusyError";
  }
}

export class BackupAuthenticationError extends Error {
  constructor() {
    super("The backup is corrupted or uses a different recovery key.");
    this.name = "BackupAuthenticationError";
  }
}

export class BackupService {
  readonly #paths: RuntimePaths;
  readonly #layout: RuntimeLayout;
  readonly #settings: DesktopSettingsStore;
  readonly #vault: CredentialVault;
  readonly #appVersion: string;
  readonly #schemaVersion: string;
  readonly #logger: DesktopLogger;
  readonly #onProgress?: (progress: NativeOperationProgress) => void;
  #activeOperation?: "backup" | "restore";

  constructor(options: {
    paths: RuntimePaths;
    layout: RuntimeLayout;
    settings: DesktopSettingsStore;
    vault: CredentialVault;
    appVersion: string;
    schemaVersion: string;
    logger?: DesktopLogger;
    onProgress?: (progress: NativeOperationProgress) => void;
  }) {
    this.#paths = options.paths;
    this.#layout = options.layout;
    this.#settings = options.settings;
    this.#vault = options.vault;
    this.#appVersion = options.appVersion;
    this.#schemaVersion = options.schemaVersion;
    this.#logger = options.logger ?? silentLogger;
    this.#onProgress = options.onProgress;
  }

  get busy(): boolean {
    return Boolean(this.#activeOperation);
  }

  get directory(): string {
    return (
      this.#settings.snapshot().backupDirectory ??
      this.#paths.defaultBackupDirectory
    );
  }

  async isStale(maximumAgeMs = 24 * 60 * 60 * 1_000): Promise<boolean> {
    const lastBackupAt = this.#settings.snapshot().lastBackupAt;
    if (!lastBackupAt) return true;
    const age = Date.now() - Date.parse(lastBackupAt);
    return !Number.isFinite(age) || age > maximumAgeMs;
  }

  async create(
    connection: PostgresConnection,
  ): Promise<BackupResult> {
    return this.#exclusive("backup", async () => {
      this.#progress("backup", "preparing", 0, 4, "Preparing encrypted backup");
      const keyRecord = await this.#getOrCreateBackupKey();
      const key = keyRecord.key;
      const archiveId = randomUUID();
      const createdAt = new Date().toISOString();
      const header: EnvelopeHeader = {
        formatVersion: 1,
        appVersion: this.#appVersion,
        schemaVersion: this.#schemaVersion,
        postgresMajor: 17,
        createdAt,
        archiveId,
        keyId: keyRecord.keyId,
        databaseName: "hardware",
        encryption: {
          algorithm: "aes-256-gcm",
          iv: randomBytes(12).toString("base64"),
          tagLength: 16,
        },
      };
      const directory = this.directory;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const displayName = `Hardware-${createdAt.replace(/[:.]/g, "-")}-${archiveId.slice(0, 8)}.hardware-backup`;
      const destination = path.join(directory, displayName);
      const temporary = path.join(
        directory,
        `.${displayName}.${randomUUID()}.tmp`,
      );
      try {
        this.#progress("backup", "dumping", 1, 4, "Encrypting PostgreSQL backup");
        await this.#dumpEncrypted(connection, header, key, temporary);
        this.#progress("backup", "verifying", 2, 4, "Verifying encrypted backup");
        const parsed = await verifyBackupArchive(temporary, key);
        await this.#listArchive(temporary, parsed, key);
        await rename(temporary, destination);
        await this.#settings.update({ lastBackupAt: createdAt });
        this.#progress("backup", "retention", 3, 4, "Applying backup retention");
        await this.#applyRetention();
        this.#progress("backup", "complete", 4, 4, "Backup complete");
        return { archiveId, createdAt, displayName };
      } finally {
        key.fill(0);
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }

  async restore(
    archivePath: string,
    connection: PostgresConnection,
    hooks: BackupRestoreHooks,
    recoveryKeyFile?: string,
  ): Promise<RestoreResult> {
    return this.#exclusive("restore", async () => {
      const envelope = await readBackupEnvelope(archivePath);
      const importedKey = recoveryKeyFile
        ? await readRecoveryKeyFile(recoveryKeyFile)
        : undefined;
      if (importedKey && importedKey.keyId !== envelope.header.keyId) {
        importedKey.key.fill(0);
        throw new BackupAuthenticationError();
      }
      const key = importedKey?.key ??
        (await this.#readBackupKey(envelope.header.keyId));
      let switched = false;
      let consumersStopped = false;
      let resumeAttempted = false;
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const stagingDatabase = `hardware_restore_${suffix}`;
      const previousDatabase = `hardware_previous_${suffix}`;
      const failedDatabase = `hardware_failed_${suffix}`;
      let header: EnvelopeHeader | undefined;
      try {
        this.#progress("restore", "verifying", 0, 7, "Verifying backup");
        let parsed: ParsedEnvelope;
        try {
          parsed = await verifyBackupArchive(archivePath, key);
        } catch {
          throw new BackupAuthenticationError();
        }
        await this.#listArchive(archivePath, parsed, key);
        header = parsed.header;
        this.#progress(
          "restore",
          "creating_staging",
          1,
          7,
          "Creating staging database",
        );
        await this.#createDatabase(stagingDatabase, connection);
        this.#progress(
          "restore",
          "restoring",
          2,
          7,
          "Restoring into staging database",
        );
        await this.#restoreEncrypted(
          archivePath,
          parsed,
          key,
          stagingDatabase,
          connection,
        );
        const stagingUrl = postgresUrl(
          connection.user,
          connection.password,
          connection.port,
          stagingDatabase,
        );
        this.#progress("restore", "migrating", 3, 7, "Migrating restored data");
        await hooks.migrateStaging(stagingUrl);
        this.#progress(
          "restore",
          "validating",
          4,
          7,
          "Validating restored catalog",
        );
        await hooks.validateStaging(stagingUrl);
        await hooks.stopConsumers();
        consumersStopped = true;
        this.#progress(
          "restore",
          "activating",
          5,
          7,
          "Activating restored catalog",
        );
        await this.#switchDatabases(
          "hardware",
          stagingDatabase,
          previousDatabase,
          connection,
        );
        switched = true;
        resumeAttempted = true;
        await hooks.startConsumers();
        consumersStopped = false;
        this.#progress(
          "restore",
          "health_check",
          6,
          7,
          "Checking restored application",
        );
        // startConsumers must resolve only after normal runtime readiness.
        if (recoveryKeyFile) {
          await this.#vault.set(
            backupKeyEntry(header.keyId),
            key.toString("base64"),
          );
        }
        await hooks
          .recordRestore?.({
            success: true,
            archiveId: header.archiveId,
          })
          .catch((auditError) => {
            this.#logger.warn({
              event: "restore_audit_failed",
              ...safeError(auditError),
            });
          });
        switched = false;
        this.#progress("restore", "complete", 7, 7, "Restore complete");
        await this.#dropDatabase(previousDatabase, connection).catch(
          (cleanupError) => {
            this.#logger.warn({
              event: "restore_previous_database_cleanup_failed",
              ...safeError(cleanupError),
            });
          },
        );
        return {
          restored: true,
          archiveId: header.archiveId,
          detail: "The backup was restored successfully.",
        };
      } catch (error) {
        this.#logger.error({
          event: "restore_failed",
          archiveId: header?.archiveId,
          ...safeError(error),
        });
        if (switched) {
          if (resumeAttempted || !consumersStopped) {
            await hooks.stopConsumers().catch(() => undefined);
            consumersStopped = true;
          }
          await this.#rollbackDatabaseSwitch(
            "hardware",
            previousDatabase,
            failedDatabase,
            connection,
          ).catch((rollbackError) => {
            this.#logger.error({
              event: "restore_rollback_failed",
              ...safeError(rollbackError),
            });
            throw rollbackError;
          });
          resumeAttempted = true;
          try {
            await hooks.startConsumers();
            consumersStopped = false;
          } catch {
            await hooks.stopConsumers().catch(() => undefined);
            consumersStopped = true;
          }
        } else {
          await this.#dropDatabase(stagingDatabase, connection).catch(
            () => undefined,
          );
          if (consumersStopped) {
            try {
              await hooks.startConsumers();
              consumersStopped = false;
            } catch {
              await hooks.stopConsumers().catch(() => undefined);
            }
          }
        }
        if (header) {
          await hooks
            .recordRestore?.({
              success: false,
              archiveId: header.archiveId,
            })
            .catch(() => undefined);
        }
        throw error;
      } finally {
        key.fill(0);
      }
    });
  }

  async exportRecoveryKey(destination: string): Promise<void> {
    const keyId = await this.#activeBackupKeyId();
    const key = await this.#readBackupKey(keyId);
    const payload = {
      formatVersion: 1,
      product: "Hardware",
      purpose: "backup-recovery-key",
      algorithm: "aes-256-gcm",
      keyId,
      key: key.toString("base64"),
      exportedAt: new Date().toISOString(),
    };
    try {
      await writeFile(destination, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "w",
        mode: 0o600,
      });
      await this.#settings.update({ recoveryKeyExported: true });
    } finally {
      key.fill(0);
    }
  }

  async #dumpEncrypted(
    connection: PostgresConnection,
    header: EnvelopeHeader,
    key: Buffer,
    destination: string,
  ): Promise<void> {
    const child = spawn(
      postgresExecutable(this.#layout, "pg_dump"),
      [
        "--format=custom",
        "--compress=6",
        "--no-owner",
        "--no-acl",
        "--dbname",
        "hardware",
      ],
      {
        cwd: this.#paths.runtime,
        env: postgresEnvironment(connection),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ) as unknown as ChildProcessWithoutNullStreams;
    const stderr = collectChildError(child);
    const envelope = new BackupEncryptTransform(header, key);
    const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    const [exitCode] = await Promise.all([
      waitForChild(child, 120_000),
      pipeline(child.stdout, envelope, output).catch((error) => {
        child.kill("SIGKILL");
        throw error;
      }),
    ]);
    if (exitCode !== 0) {
      throw new Error(`pg_dump failed (${stderr() || "no diagnostic"}).`);
    }
  }

  async #restoreEncrypted(
    archivePath: string,
    parsed: ParsedEnvelope,
    key: Buffer,
    database: string,
    connection: PostgresConnection,
  ): Promise<void> {
    const child = spawn(
      postgresExecutable(this.#layout, "pg_restore"),
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-acl",
        "--dbname",
        database,
        "-",
      ],
      {
        cwd: this.#paths.runtime,
        env: postgresEnvironment(connection),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;
    const stderr = collectChildError(child);
    child.stdout.resume();
    const input = ciphertextStream(archivePath, parsed);
    const decipher = createDecipher(parsed, key);
    const [exitCode] = await Promise.all([
      waitForChild(child, 180_000),
      pipeline(input, decipher, child.stdin).catch((error) => {
        child.kill("SIGKILL");
        throw error;
      }),
    ]);
    if (exitCode !== 0) {
      throw new Error(`pg_restore failed (${stderr() || "no diagnostic"}).`);
    }
  }

  async #createDatabase(
    database: string,
    connection: PostgresConnection,
  ): Promise<void> {
    await runPostgresUtility(
      postgresExecutable(this.#layout, "createdb"),
      [
        "--host",
        connection.host,
        "--port",
        String(connection.port),
        "--username",
        connection.user,
        database,
      ],
      this.#paths.runtime,
      connection,
    );
  }

  async #listArchive(
    archivePath: string,
    parsed: ParsedEnvelope,
    key: Buffer,
  ): Promise<void> {
    const child = spawn(
      postgresExecutable(this.#layout, "pg_restore"),
      ["--list", "-"],
      {
        cwd: this.#paths.runtime,
        env: { ...process.env, PGPASSWORD: undefined },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      },
    ) as unknown as ChildProcessWithoutNullStreams;
    const stderr = collectChildError(child);
    const input = ciphertextStream(archivePath, parsed);
    const decipher = createDecipher(parsed, key);
    const [exitCode] = await Promise.all([
      waitForChild(child, 60_000),
      pipeline(input, decipher, child.stdin).catch((error) => {
        child.kill("SIGKILL");
        throw error;
      }),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `The PostgreSQL archive is invalid (${stderr() || "no diagnostic"}).`,
      );
    }
  }

  async #dropDatabase(
    database: string,
    connection: PostgresConnection,
  ): Promise<void> {
    await runPostgresUtility(
      postgresExecutable(this.#layout, "dropdb"),
      [
        "--if-exists",
        "--force",
        "--host",
        connection.host,
        "--port",
        String(connection.port),
        "--username",
        connection.user,
        database,
      ],
      this.#paths.runtime,
      connection,
    );
  }

  async #switchDatabases(
    current: string,
    staging: string,
    previous: string,
    connection: PostgresConnection,
  ): Promise<void> {
    await this.#runAdminSql(
      [
        "begin;",
        terminateDatabaseConnectionsSql(current),
        terminateDatabaseConnectionsSql(staging),
        `alter database ${quoteIdentifier(current)} rename to ${quoteIdentifier(previous)};`,
        `alter database ${quoteIdentifier(staging)} rename to ${quoteIdentifier(current)};`,
        "commit;",
      ].join("\n"),
      connection,
    );
  }

  async #rollbackDatabaseSwitch(
    current: string,
    previous: string,
    failed: string,
    connection: PostgresConnection,
  ): Promise<void> {
    await this.#runAdminSql(
      [
        "begin;",
        terminateDatabaseConnectionsSql(current),
        terminateDatabaseConnectionsSql(previous),
        `alter database ${quoteIdentifier(current)} rename to ${quoteIdentifier(failed)};`,
        `alter database ${quoteIdentifier(previous)} rename to ${quoteIdentifier(current)};`,
        "commit;",
      ].join("\n"),
      connection,
    );
    await this.#dropDatabase(failed, connection).catch(() => undefined);
  }

  async #runAdminSql(
    sql: string,
    connection: PostgresConnection,
  ): Promise<void> {
    await runPostgresUtility(
      postgresExecutable(this.#layout, "psql"),
      [
        "--host",
        connection.host,
        "--port",
        String(connection.port),
        "--username",
        connection.user,
        "--dbname",
        "postgres",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        sql,
      ],
      this.#paths.runtime,
      connection,
    );
  }

  async #applyRetention(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const archives: Array<{ path: string; manifest: BackupManifest }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".hardware-backup")) continue;
      const file = path.join(this.directory, entry.name);
      try {
        const parsed = await readBackupEnvelope(file);
        archives.push({ path: file, manifest: parsed.header });
      } catch {
        // A damaged archive remains available for manual diagnosis.
      }
    }
    const retained = selectRetainedBackups(archives.map((item) => item.manifest));
    for (const archive of archives) {
      if (!retained.has(archive.manifest.archiveId)) {
        await rm(archive.path, { force: true });
      }
    }
  }

  async #exclusive<T>(
    operation: "backup" | "restore",
    callback: () => Promise<T>,
  ): Promise<T> {
    if (this.#activeOperation) throw new NativeOperationBusyError();
    this.#activeOperation = operation;
    try {
      return await callback();
    } finally {
      this.#activeOperation = undefined;
    }
  }

  async #getOrCreateBackupKey(): Promise<{
    keyId: string;
    key: Buffer;
  }> {
    const activeKeyId = await this.#vault.get(ACTIVE_BACKUP_KEY_ID_ENTRY);
    if (activeKeyId) {
      return {
        keyId: z.string().uuid().parse(activeKeyId),
        key: await this.#readBackupKey(activeKeyId),
      };
    }
    const legacy = await this.#vault.get(LEGACY_BACKUP_KEY_VAULT_ENTRY);
    if (legacy) {
      const key = decodeBackupKey(legacy);
      const keyId = deterministicLegacyKeyId(key);
      await this.#vault.set(backupKeyEntry(keyId), legacy);
      await this.#vault.set(ACTIVE_BACKUP_KEY_ID_ENTRY, keyId);
      return { keyId, key };
    }
    const keyId = randomUUID();
    const key = randomBytes(32);
    await this.#vault.set(backupKeyEntry(keyId), key.toString("base64"));
    await this.#vault.set(ACTIVE_BACKUP_KEY_ID_ENTRY, keyId);
    return { keyId, key };
  }

  async #activeBackupKeyId(): Promise<string> {
    const record = await this.#getOrCreateBackupKey();
    record.key.fill(0);
    return record.keyId;
  }

  async #readBackupKey(keyId: string): Promise<Buffer> {
    const parsedKeyId = z.string().uuid().parse(keyId);
    const encoded = await this.#vault.get(backupKeyEntry(parsedKeyId));
    if (!encoded) {
      throw new BackupAuthenticationError();
    }
    return decodeBackupKey(encoded);
  }

  #progress(
    operation: "backup" | "restore",
    phase: string,
    completed: number,
    total: number,
    detail: string,
  ): void {
    this.#onProgress?.({ operation, phase, completed, total, detail });
  }
}

export class BackupEncryptTransform extends Transform {
  readonly #headerBytes: Buffer;
  readonly #cipher: CipherGCM;
  #prefixed = false;

  constructor(header: EnvelopeHeader, key: Buffer) {
    super();
    this.#headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    if (this.#headerBytes.byteLength > MAX_HEADER_BYTES) {
      throw new Error("The backup manifest is too large.");
    }
    this.#cipher = createCipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(header.encryption.iv, "base64"),
    ) as CipherGCM;
    this.#cipher.setAAD(this.#headerBytes);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.#prefix();
      this.push(this.#cipher.update(chunk));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.#prefix();
      this.push(this.#cipher.final());
      this.push(this.#cipher.getAuthTag());
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  #prefix(): void {
    if (this.#prefixed) return;
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(this.#headerBytes.byteLength);
    this.push(Buffer.concat([MAGIC, length, this.#headerBytes]));
    this.#prefixed = true;
  }
}

export async function readBackupEnvelope(
  file: string,
): Promise<ParsedEnvelope> {
  const details = await stat(file);
  if (!details.isFile() || details.size < PREFIX_BYTES + AUTH_TAG_BYTES + 1) {
    throw new Error("This is not a valid Hardware backup.");
  }
  const handle = await open(file, "r");
  try {
    const prefix = Buffer.alloc(PREFIX_BYTES);
    await handle.read({ buffer: prefix, position: 0 });
    if (!prefix.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      throw new Error("This is not a Hardware backup.");
    }
    const headerLength = prefix.readUInt32BE(MAGIC.byteLength);
    if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) {
      throw new Error("The backup manifest is invalid.");
    }
    const payloadOffset = PREFIX_BYTES + headerLength;
    if (details.size <= payloadOffset + AUTH_TAG_BYTES) {
      throw new Error("The backup payload is truncated.");
    }
    const headerBytes = Buffer.alloc(headerLength);
    await handle.read({ buffer: headerBytes, position: PREFIX_BYTES });
    const header = envelopeHeaderSchema.parse(
      JSON.parse(headerBytes.toString("utf8")),
    );
    const authTag = Buffer.alloc(AUTH_TAG_BYTES);
    await handle.read({
      buffer: authTag,
      position: details.size - AUTH_TAG_BYTES,
    });
    return {
      header,
      headerBytes,
      payloadOffset,
      ciphertextEnd: details.size - AUTH_TAG_BYTES - 1,
      authTag,
      size: details.size,
    };
  } finally {
    await handle.close();
  }
}

export async function verifyBackupArchive(
  file: string,
  key: Buffer,
): Promise<ParsedEnvelope> {
  const parsed = await readBackupEnvelope(file);
  const decipher = createDecipher(parsed, key);
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  try {
    await pipeline(ciphertextStream(file, parsed), decipher, sink);
    return parsed;
  } catch {
    throw new BackupAuthenticationError();
  }
}

export async function readRecoveryKeyFile(
  file: string,
): Promise<{ keyId: string; key: Buffer }> {
  const handle = await open(file, "r");
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > 16 * 1024) {
      throw new Error("The recovery-key file is invalid.");
    }
    const contents = Buffer.alloc(details.size);
    await handle.read({ buffer: contents, position: 0 });
    const parsed = recoveryKeyFileSchema.parse(
      JSON.parse(contents.toString("utf8")),
    );
    const key = Buffer.from(parsed.key, "base64");
    if (key.byteLength !== 32) {
      throw new Error("The recovery-key file is invalid.");
    }
    return { keyId: parsed.keyId, key };
  } finally {
    await handle.close();
  }
}

function backupKeyEntry(keyId: string): string {
  return `backup:key:${keyId}`;
}

function decodeBackupKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32) throw new Error("The backup key is damaged.");
  return key;
}

function deterministicLegacyKeyId(key: Buffer): string {
  const digest = createHash("sha256").update(key).digest("hex");
  const candidate = [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
  return candidate;
}

function ciphertextStream(
  file: string,
  parsed: ParsedEnvelope,
): ReadStream {
  return createReadStream(file, {
    start: parsed.payloadOffset,
    end: parsed.ciphertextEnd,
  });
}

function createDecipher(
  parsed: ParsedEnvelope,
  key: Buffer,
): DecipherGCM {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(parsed.header.encryption.iv, "base64"),
  );
  decipher.setAAD(parsed.headerBytes);
  decipher.setAuthTag(parsed.authTag);
  return decipher as DecipherGCM;
}

export function selectRetainedBackups(
  manifests: BackupManifest[],
): Set<string> {
  const sorted = [...manifests].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  const retained = new Set<string>();
  const daily = new Set<string>();
  const weekly = new Set<string>();
  for (const manifest of sorted) {
    const date = new Date(manifest.createdAt);
    if (!Number.isFinite(date.getTime())) continue;
    const day = manifest.createdAt.slice(0, 10);
    if (daily.size < 7 && !daily.has(day)) {
      daily.add(day);
      retained.add(manifest.archiveId);
    }
    const week = isoWeekKey(date);
    if (weekly.size < 4 && !weekly.has(week)) {
      weekly.add(week);
      retained.add(manifest.archiveId);
    }
  }
  return retained;
}

function isoWeekKey(date: Date): string {
  const value = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function postgresEnvironment(
  connection: PostgresConnection,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
    PGSSLMODE: "disable",
  };
}

function collectChildError(
  child: ChildProcessWithoutNullStreams,
): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (size >= 16 * 1024) return;
    const available = 16 * 1024 - size;
    chunks.push(chunk.subarray(0, available));
    size += Math.min(chunk.byteLength, available);
  });
  return () =>
    Buffer.concat(chunks)
      .toString("utf8")
      .replace(/postgresql:\/\/[^\s]+/gi, "[database-url-redacted]")
      .slice(0, 2_000)
      .trim();
}

function waitForChild(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 120_000,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The PostgreSQL utility timed out."));
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`PostgreSQL utility stopped with ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

async function runPostgresUtility(
  executable: string,
  args: readonly string[],
  cwd: string,
  connection: PostgresConnection,
): Promise<void> {
  const child = spawn(executable, args, {
    cwd,
    env: postgresEnvironment(connection),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ChildProcessWithoutNullStreams;
  child.stdout.resume();
  const stderr = collectChildError(child);
  const code = await waitForChild(child, 120_000);
  if (code !== 0) {
    throw new Error(`PostgreSQL utility failed (${stderr() || "no diagnostic"}).`);
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^hardware(?:_[a-z0-9]+)*$/.test(identifier)) {
    throw new Error("Unsafe database identifier.");
  }
  return `"${identifier}"`;
}

function terminateDatabaseConnectionsSql(database: string): string {
  return `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${database}' and pid <> pg_backend_pid();`;
}
