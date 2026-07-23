import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backup = readFileSync(
  new URL("../../deploy/local-backup.sh", import.meta.url),
  "utf8",
);
const restore = readFileSync(
  new URL("../../deploy/local-restore.sh", import.meta.url),
  "utf8",
);

describe("local encrypted database operations", () => {
  it("verifies an encrypted custom archive before publishing it", () => {
    const encryptIndex = backup.indexOf("openssl enc -aes-256-cbc -pbkdf2");
    const listIndex = backup.indexOf('pg_restore --list "$verified"');
    const publishIndex = backup.indexOf('mv "$staged" "$encrypted"');

    expect(backup).toContain("pg_dump");
    expect(backup).toContain("--format custom");
    expect(encryptIndex).toBeGreaterThan(0);
    expect(backup).toContain("-iter 250000");
    expect(backup).toContain(".dump.enc");
    expect(backup).toContain("sha256sum");
    expect(listIndex).toBeGreaterThan(encryptIndex);
    expect(publishIndex).toBeGreaterThan(listIndex);
  });

  it("keeps plaintext in ephemeral paths and removes it on every exit", () => {
    expect(backup).toMatch(
      /trap '[^']*rm -f[^']*\$plain[^']*\$verified[^']*' EXIT HUP INT TERM/u,
    );
    expect(backup).not.toMatch(/\/backups\/[^\n"']+\.dump(?:["']|$)/u);
  });

  it("validates bounded retention and never recurses during cleanup", () => {
    const validationIndex = backup.indexOf(
      'validate_retention "$retention_days" BACKUP_RETENTION_DAYS 3650',
    );
    const dumpIndex = backup.indexOf("pg_dump");
    const cleanupLines = backup
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('find "$daily_dir"'));

    expect(validationIndex).toBeGreaterThan(0);
    expect(validationIndex).toBeLessThan(dumpIndex);
    expect(backup).toContain(
      'validate_retention "$retention_weeks" BACKUP_RETENTION_WEEKS 520',
    );
    expect(backup).toContain("*[!0-9]*|0[0-9]*");
    expect(cleanupLines).toHaveLength(2);
    for (const line of cleanupLines) {
      expect(line).toContain("-mindepth 1 -maxdepth 1");
    }
    expect(backup).toMatch(
      /find "\$weekly_dir" -mindepth 1 -maxdepth 1 -type f/gu,
    );
  });

  it("preflights the archive before restoring into an isolated database", () => {
    const basenameIndex = restore.indexOf('hardware-*.dump.enc)');
    const checksumIndex = restore.indexOf('sha256sum -c');
    const decryptIndex = restore.indexOf('openssl enc -d');
    const listIndex = restore.indexOf('pg_restore --list "$plain"');
    const createIndex = restore.indexOf("createdb --host postgres");
    const restoreIndex = restore.lastIndexOf("pg_restore \\");
    const switchIndex = restore.indexOf(
      'alter database \\"$POSTGRES_DB\\" rename to \\"$previous_database\\"',
    );

    expect(basenameIndex).toBeGreaterThan(0);
    expect(checksumIndex).toBeGreaterThan(basenameIndex);
    expect(decryptIndex).toBeGreaterThan(checksumIndex);
    expect(listIndex).toBeGreaterThan(decryptIndex);
    expect(createIndex).toBeGreaterThan(listIndex);
    expect(restoreIndex).toBeGreaterThan(createIndex);
    expect(switchIndex).toBeGreaterThan(restoreIndex);
    expect(restore).toContain("--exit-on-error");
    expect(restore).toContain("--single-transaction");
  });

  it("retains the original database until the restored catalog passes checks", () => {
    const commitIndex = restore.indexOf('if [ "$action" = "commit" ]');
    const stageIndex = restore.lastIndexOf('case "${RESTORE_FILE:-}" in');
    const retainIndex = restore.indexOf("stage_complete=1", stageIndex);
    const dropPreviousIndex = restore.indexOf(
      'dropdb --host postgres --username "$POSTGRES_USER"',
      commitIndex,
    );

    expect(restore).toContain('temporary_database="${POSTGRES_DB}_restore_${operation_id}"');
    expect(restore).toContain('previous_database="${POSTGRES_DB}_before_${operation_id}"');
    expect(restore).toContain('failed_database="${POSTGRES_DB}_failed_${operation_id}"');
    expect(restore).toContain('rename to \\"$previous_database\\"');
    expect(restore).toContain('rename to \\"$POSTGRES_DB\\"');
    expect(restore).toContain('select count(*) from projects');
    expect(commitIndex).toBeGreaterThan(0);
    expect(dropPreviousIndex).toBeGreaterThan(commitIndex);
    expect(dropPreviousIndex).toBeLessThan(stageIndex);
    expect(retainIndex).toBeGreaterThan(stageIndex);
    expect(restore).toContain('if [ "$action" = "prepare" ]');
    expect(restore).toContain('truncate table worker_heartbeats');
    expect(restore).toContain("the original database is retained pending application readiness");
  });

  it("never deletes a pre-existing database after a reserved-name collision", () => {
    const preflightIndex = restore.indexOf(
      'for reserved_database in "$temporary_database" "$previous_database" "$failed_database"',
    );
    const createIndex = restore.indexOf("createdb --host postgres");
    const ownershipFlagIndex = restore.indexOf("temporary_created=0");
    const ownershipIndex = restore.indexOf("temporary_created=1", createIndex);
    const guardedTemporaryDrop = restore.indexOf(
      'if [ "$temporary_created" -eq 1 ] && database_exists "$temporary_database"',
    );
    const guardedFailedDrop = restore.indexOf(
      'if [ "$failed_created" -eq 1 ] && [ "$original_reactivated" -eq 1 ]',
    );

    expect(preflightIndex).toBeGreaterThan(0);
    expect(preflightIndex).toBeLessThan(createIndex);
    expect(ownershipFlagIndex).toBeGreaterThan(preflightIndex);
    expect(guardedTemporaryDrop).toBeGreaterThan(ownershipFlagIndex);
    expect(guardedFailedDrop).toBeGreaterThan(ownershipFlagIndex);
    expect(ownershipIndex).toBeGreaterThan(createIndex);
    expect(restore).toContain("rollback_failed_created=0");
    expect(restore).toContain('if [ "$rollback_failed_created" -eq 1 ]');
    expect(restore).toContain(
      "Rollback stopped because its reserved failed-database name already exists.",
    );
    expect(restore).not.toContain("local.restore_succeeded");
  });
});
