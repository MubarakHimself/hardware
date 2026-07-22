import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backup = readFileSync(
  new URL("../../deploy/backup.sh", import.meta.url),
  "utf8",
);
const restore = readFileSync(
  new URL("../../deploy/restore.sh", import.meta.url),
  "utf8",
);

describe("encrypted database operations", () => {
  it("streams pg_dump into PBKDF2 encryption without a plaintext dump file", () => {
    expect(backup).toContain("set -Eeuo pipefail");
    expect(backup).toMatch(/pg_dump[\s\S]+\| \\\n  openssl enc/);
    expect(backup).toContain("BACKUP_CIPHER=aes-256-cbc");
    expect(backup).toContain("-pbkdf2");
    expect(backup).toContain("PBKDF2_ITERATIONS=600000");
    expect(backup).toContain(".dump.enc");
    expect(backup).not.toMatch(/\.dump["']?\s*>/);
  });

  it("requires integrity and archive preflight checks before destructive restore", () => {
    const checksumIndex = restore.indexOf('verify_manifest "$backup_file"');
    const preflightIndex = restore.indexOf("pg_restore --list");
    const stopIndex = restore.indexOf(
      'docker compose --env-file "$ENV_FILE" stop web worker',
    );

    expect(checksumIndex).toBeGreaterThan(0);
    expect(preflightIndex).toBeGreaterThan(checksumIndex);
    expect(stopIndex).toBeGreaterThan(preflightIndex);
    expect(restore).toContain("--single-transaction");
    expect(restore).toContain("openssl enc -d");
    expect(restore).not.toContain("mktemp");
  });
});
