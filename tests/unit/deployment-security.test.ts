import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync(
  new URL("../../docker-compose.yml", import.meta.url),
  "utf8",
);
const dockerfile = readFileSync(
  new URL("../../Dockerfile", import.meta.url),
  "utf8",
);
const exampleEnvironment = readFileSync(
  new URL("../../.env.example", import.meta.url),
  "utf8",
);
const launcher = readFileSync(
  new URL("../../hardware.ps1", import.meta.url),
  "utf8",
);
const runtimeVerifier = readFileSync(
  new URL("../../deploy/verify-local-runtime.ps1", import.meta.url),
  "utf8",
);
const operations = readFileSync(
  new URL("../../docs/OPERATIONS.md", import.meta.url),
  "utf8",
);
const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

function composeService(name: string) {
  const match = compose.match(
    new RegExp(
      `^  ${name}:\\r?\\n[\\s\\S]*?(?=^  [a-zA-Z0-9_-]+:\\r?$|^networks:|^volumes:)`,
      "mu",
    ),
  );
  expect(match, `Compose service ${name} must exist`).not.toBeNull();
  return match![0];
}

function powershellFunction(name: string) {
  const start = launcher.indexOf(`function ${name}`);
  expect(start, `PowerShell function ${name} must exist`).toBeGreaterThan(-1);
  const next = launcher.indexOf("\nfunction ", start + 1);
  return launcher.slice(start, next === -1 ? undefined : next);
}

describe("personal local deployment boundary", () => {
  it("binds direct npm web servers to IPv4 loopback", () => {
    expect(packageManifest.scripts.dev).toBe("next dev -H 127.0.0.1");
    expect(packageManifest.scripts.start).toBe("next start -H 127.0.0.1");
    expect(operations).toContain("desktop browser at `1024px` wide or larger");
    expect(operations).toContain("no mobile or tablet UI");
  });

  it("publishes only the web UI on the IPv4 loopback interface", () => {
    const web = composeService("web");
    const worker = composeService("worker");
    const postgres = composeService("postgres");

    expect(web).toContain(
      '"127.0.0.1:${HARDWARE_PORT:-3000}:3000"',
    );
    expect(compose).not.toMatch(/\n\s+caddy:/u);
    expect(compose).not.toMatch(/- ["']?(?:80|443):/u);
    expect(postgres).not.toMatch(/^    ports:/mu);
    expect(worker).not.toMatch(/^    ports:/mu);
  });

  it("persists PostgreSQL and makes application filesystems read-only", () => {
    const postgres = composeService("postgres");
    expect(postgres).toContain("postgres-data:/var/lib/postgresql/data");
    expect(compose).toMatch(/^volumes:\r?\n  postgres-data:\s*$/mu);
    for (const service of ["migrate", "web", "worker"]) {
      expect(composeService(service)).toMatch(/^    read_only:\s*true$/mu);
    }
  });

  it("has no Clerk, domain, or public certificate requirement", () => {
    for (const source of [compose, dockerfile, exampleEnvironment]) {
      expect(source).not.toMatch(/CLERK|ACME_EMAIL|APP_DOMAIN/u);
    }
    expect(exampleEnvironment).toMatch(/^APP_MODE=local$/mu);
    expect(exampleEnvironment).toMatch(
      /^NEXT_PUBLIC_APP_URL=http:\/\/127\.0\.0\.1:3000$/mu,
    );
  });

  it("accepts only the canonical singleton owner in launcher audit operations", () => {
    const recordOperation = powershellFunction("Record-LocalOperation");

    expect(recordOperation).toContain(
      '[string]::Equals(\n      $ownerId,\n      "00000000-0000-4000-8000-000000000001",\n      [StringComparison]::Ordinal',
    );
    expect(recordOperation).toContain(
      "LOCAL_OWNER_ID must equal 00000000-0000-4000-8000-000000000001 for this single-user installation.",
    );
    expect(recordOperation).not.toContain("^[0-9a-fA-F-]{36}$");
  });

  it("uses the configured loopback origin for probes and browser launch", () => {
    expect(launcher).toContain('Get-EnvironmentValue "NEXT_PUBLIC_APP_URL"');
    for (const name of [
      "Wait-HardwareReady",
      "Assert-CatalogReadable",
      "Start-Hardware",
    ]) {
      expect(powershellFunction(name)).not.toContain("http://127.0.0.1:3000");
    }
  });

  it("generates local secrets and never deletes the database volume", () => {
    expect(launcher).toContain("New-HexSecret 32");
    expect(launcher).toContain("New-HexSecret 48");
    expect(launcher).toContain('.env.local');
    expect(launcher).toContain('@("stop", "web", "worker", "postgres")');
    expect(launcher).not.toContain("down -v");
    expect(launcher).not.toContain("docker volume rm");
  });

  it("does not silently replace the key of an existing installation", () => {
    const initialize = powershellFunction("Initialize-Hardware");
    const configuredIndex = initialize.indexOf(
      "Test-Path -LiteralPath $environmentFile",
    );
    const keyWriteIndex = initialize.indexOf(
      "[IO.File]::WriteAllText($configuredBackupKeyFile",
    );
    const guard = initialize.slice(configuredIndex, keyWriteIndex);

    expect(configuredIndex).toBeGreaterThan(0);
    expect(keyWriteIndex).toBeGreaterThan(configuredIndex);
    expect(initialize).toContain(
      "$configuredBackupKeyFile = if ($alreadyConfigured) { Get-BackupKeyFile }",
    );
    expect(guard).toContain("$configuredBackupKeyFile");
    expect(guard).toMatch(/throw/iu);
  });

  it("uses file-configured backup paths instead of inherited Compose overrides", () => {
    const invokeCompose = powershellFunction("Invoke-Compose");
    const backupKey = powershellFunction("Get-BackupKeyFile");
    const setIndex = invokeCompose.indexOf(
      "[Environment]::SetEnvironmentVariable($name, [string]$composeFileOverrides[$name]",
    );
    const composeIndex = invokeCompose.indexOf("& docker compose");
    const restoreIndex = invokeCompose.lastIndexOf(
      "[Environment]::SetEnvironmentVariable($name, $previousComposeEnvironment[$name]",
    );

    expect(invokeCompose).toContain("HARDWARE_BACKUP_DIR = Get-BackupDirectory");
    expect(invokeCompose).toContain("BACKUP_KEY_FILE = Get-BackupKeyFile");
    expect(invokeCompose).toContain("COMPOSE_FILE = $composeFile");
    expect(invokeCompose).toContain(
      "COMPOSE_PROJECT_NAME = $composeProjectName",
    );
    expect(invokeCompose).toContain("BACKUP_RETENTION_DAYS = $retentionDays");
    expect(invokeCompose).toContain("BACKUP_RETENTION_WEEKS = $retentionWeeks");
    expect(setIndex).toBeGreaterThan(0);
    expect(composeIndex).toBeGreaterThan(setIndex);
    expect(restoreIndex).toBeGreaterThan(composeIndex);
    expect(backupKey).toContain('Get-EnvironmentValue "BACKUP_KEY_FILE"');
  });

  it("pins every launcher Compose operation to this workspace and project", () => {
    const invokeCompose = powershellFunction("Invoke-Compose");
    const rawComposeCommands = launcher.match(/\bdocker\s+compose\b/gu) ?? [];

    expect(launcher).toContain(
      '$composeFile = [IO.Path]::GetFullPath((Join-Path $scriptRoot "docker-compose.yml"))',
    );
    expect(launcher).toContain('$composeProjectName = "hardware"');
    expect(invokeCompose).toContain(
      "& docker compose --file $composeFile --project-name $composeProjectName --env-file $environmentFile @Arguments",
    );
    expect(invokeCompose).toContain(
      "Test-Path -LiteralPath $composeFile -PathType Leaf",
    );
    expect(rawComposeCommands).toHaveLength(1);

    for (const functionName of [
      "Protect-CurrentImageForRollback",
      "Get-DatabaseSchemaVersion",
      "Get-PostgresDatabaseNames",
      "Rename-PostgresDatabase",
      "Stop-PostgresDatabaseConnections",
      "Record-LocalOperation",
      "Recover-InterruptedRestore",
      "Start-Hardware",
      "Stop-Hardware",
      "Show-HardwareStatus",
      "Backup-Hardware",
      "Invoke-RestoreAction",
      "Invoke-VerifiedRestore",
      "Update-Hardware",
    ]) {
      expect(powershellFunction(functionName)).not.toMatch(/\bdocker\s+compose\b/u);
    }
  });

  it("uses the explicit visible backup folder and daily/weekly retention", () => {
    expect(exampleEnvironment).toMatch(/^HARDWARE_BACKUP_DIR=.\/backups$/mu);
    expect(exampleEnvironment).toMatch(/^BACKUP_RETENTION_DAYS=7$/mu);
    expect(exampleEnvironment).toMatch(/^BACKUP_RETENTION_WEEKS=4$/mu);
  });

  it("suppresses only the browser launch when NoOpen is selected", () => {
    const start = powershellFunction("Start-Hardware");
    expect(launcher).toContain("[switch]$NoOpen");
    expect(start).toContain("if (-not $NoOpen) { Start-Process $origin }");
    expect(operations).toContain(".\\hardware.ps1 start -NoOpen");
    expect(operations).toContain("suppresses the final browser launch");
  });

  it("ships an isolated opt-in runtime lifecycle verifier", () => {
    expect(packageManifest.scripts["verify:runtime"]).toContain(
      "deploy\\verify-local-runtime.ps1",
    );
    expect(runtimeVerifier).toContain('$projectName = "hardware-verify-$runId"');
    expect(runtimeVerifier).toContain("Assert-DisposableBoundary");
    expect(runtimeVerifier).toContain("--project-name $projectName");
    expect(runtimeVerifier).not.toContain(".env.local");
    expect(runtimeVerifier).toContain("Assert-LoopbackPublication");
    expect(runtimeVerifier).toContain('"--force-recreate", "--wait", "postgres"');
    expect(runtimeVerifier).toContain("New-EncryptedBackup");
    expect(runtimeVerifier).toContain("Invoke-DisposableRestore $archiveName $priorRelease");
    expect(runtimeVerifier).toContain('"exited:42"');
    expect(runtimeVerifier).toContain('down --volumes --remove-orphans');
    expect(runtimeVerifier.indexOf("Assert-DisposableBoundary")).toBeLessThan(
      runtimeVerifier.lastIndexOf("Remove-Item -LiteralPath $temporaryRoot -Recurse -Force"),
    );
  });

  it("commits a staged restore only after migrations and application readiness", () => {
    const verifiedRestore = powershellFunction("Invoke-VerifiedRestore");
    const stageIndex = verifiedRestore.indexOf('Invoke-RestoreAction "stage"');
    const migrationIndex = verifiedRestore.indexOf(
      'Invoke-Compose @("run", "--rm", "--no-deps", "migrate")',
    );
    const prepareIndex = verifiedRestore.indexOf('Invoke-RestoreAction "prepare"');
    const readyIndex = verifiedRestore.indexOf("Wait-HardwareReady");
    const catalogIndex = verifiedRestore.indexOf("Assert-CatalogReadable");
    const auditIndex = verifiedRestore.indexOf(
      "Record-LocalOperation $successAction",
    );
    const commitIndex = verifiedRestore.indexOf('Invoke-RestoreAction "commit"');

    expect(stageIndex).toBeGreaterThan(0);
    expect(migrationIndex).toBeGreaterThan(stageIndex);
    expect(prepareIndex).toBeGreaterThan(migrationIndex);
    expect(readyIndex).toBeGreaterThan(prepareIndex);
    expect(catalogIndex).toBeGreaterThan(readyIndex);
    expect(auditIndex).toBeGreaterThan(catalogIndex);
    expect(commitIndex).toBeGreaterThan(auditIndex);
    expect(verifiedRestore).toContain('"local.restore_succeeded"');
    expect(verifiedRestore).toContain('"local.update_rollback_succeeded"');
    expect(verifiedRestore).toContain('Invoke-RestoreAction "rollback"');
  });

  it("recovers the newest interrupted restore before starting application services", () => {
    const start = powershellFunction("Start-Hardware");
    const postgresIndex = start.indexOf(
      'Invoke-Compose @("up", "-d", "--wait", "postgres")',
    );
    const recoveryIndex = start.indexOf("Recover-InterruptedRestore");
    const appStartIndex = start.indexOf("Invoke-Compose $startArguments");

    expect(postgresIndex).toBeGreaterThan(0);
    expect(recoveryIndex).toBeGreaterThan(postgresIndex);
    expect(appStartIndex).toBeGreaterThan(recoveryIndex);
  });

  it("preserves every catalog while conservatively rolling back an interrupted restore", () => {
    const recovery = powershellFunction("Recover-InterruptedRestore");
    const olderIndex = recovery.indexOf("Select-Object -Skip 1");
    const heldIndex = recovery.indexOf(
      'New-RecoveryDatabaseName $databaseName "held"',
    );
    const canonicalCheckIndex = recovery.indexOf(
      "Test-ExactDatabaseName $databaseNames $databaseName",
    );
    const failedIndex = recovery.indexOf(
      'New-RecoveryDatabaseName $databaseName "failed"',
    );
    const terminateIndex = recovery.indexOf(
      "Stop-PostgresDatabaseConnections $databaseName",
    );
    const reactivateIndex = recovery.indexOf(
      "Rename-PostgresDatabase $newest.Name $databaseName",
    );

    expect(recovery).toContain("Sort-Object OperationId -Descending");
    expect(recovery).toContain("$newest = $candidates[0]");
    expect(recovery).toContain("[0-9]{14}[A-Fa-f0-9]{4}");
    expect(recovery).toContain(
      'Invoke-Compose @("stop", "web", "worker", "migrate")',
    );
    expect(olderIndex).toBeGreaterThan(0);
    expect(heldIndex).toBeGreaterThan(olderIndex);
    expect(canonicalCheckIndex).toBeGreaterThan(heldIndex);
    expect(failedIndex).toBeGreaterThan(canonicalCheckIndex);
    expect(terminateIndex).toBeGreaterThan(failedIndex);
    expect(reactivateIndex).toBeGreaterThan(terminateIndex);
    expect(recovery).not.toMatch(/dropdb|drop database/iu);
  });

  it("validates every identifier used by the startup recovery SQL", () => {
    const assertion = powershellFunction("Assert-SafePostgresIdentifier");
    const inventory = powershellFunction("Get-PostgresDatabaseNames");
    const rename = powershellFunction("Rename-PostgresDatabase");
    const terminate = powershellFunction("Stop-PostgresDatabaseConnections");
    const recovery = powershellFunction("Recover-InterruptedRestore");

    expect(assertion).toContain("$Value.Length -gt 63");
    expect(assertion).toContain("^[A-Za-z0-9_]+$");
    expect(inventory).toContain(
      'Assert-SafePostgresIdentifier "POSTGRES_USER" $databaseUser',
    );
    expect(rename).toContain(
      'Assert-SafePostgresIdentifier "Current database name" $CurrentName',
    );
    expect(rename).toContain(
      'Assert-SafePostgresIdentifier "New database name" $NewName',
    );
    expect(terminate).toContain(
      'Assert-SafePostgresIdentifier "Database name" $DatabaseName',
    );
    expect(recovery).toContain(
      'Assert-SafePostgresIdentifier "POSTGRES_DB" $databaseName',
    );
  });

  it("quiesces writers before the mandatory pre-update backup", () => {
    const update = powershellFunction("Update-Hardware");
    const readyIndex = update.indexOf("Wait-HardwareReady");
    const protectedUpdateIndex = update.indexOf("try {");
    const stopIndex = update.indexOf(
      'Invoke-Compose @("stop", "web", "worker")',
    );
    const backupIndex = update.indexOf("Backup-Hardware");
    const buildIndex = update.indexOf(
      'Invoke-Compose @("build", "migrate", "web", "worker")',
    );

    expect(readyIndex).toBeGreaterThan(0);
    expect(protectedUpdateIndex).toBeGreaterThan(readyIndex);
    expect(stopIndex).toBeGreaterThan(protectedUpdateIndex);
    expect(backupIndex).toBeGreaterThan(stopIndex);
    expect(buildIndex).toBeGreaterThan(backupIndex);
    expect(update).toContain("Invoke-VerifiedRestore $preUpdateBackup.Name -UsePriorImage");
  });

  it("protects the running image independently of a same-SHA rebuild", () => {
    const update = powershellFunction("Update-Hardware");
    const protect = powershellFunction("Protect-CurrentImageForRollback");
    const protectIndex = update.indexOf("Protect-CurrentImageForRollback");
    const buildIndex = update.indexOf(
      'Invoke-Compose @("build", "migrate", "web", "worker")',
    );
    const retagIndex = update.indexOf(
      '& docker image tag "hardware:rollback" "hardware:$previousRelease"',
    );

    expect(protectIndex).toBeGreaterThan(0);
    expect(buildIndex).toBeGreaterThan(protectIndex);
    expect(retagIndex).toBeGreaterThan(buildIndex);
    const composeLookupIndex = protect.indexOf(
      '$containerIds = @(Invoke-Compose @("ps", "--quiet", "web"))',
    );
    expect(composeLookupIndex).toBeGreaterThan(0);
    expect(protect.indexOf("Select-Object -First 1")).toBeGreaterThan(
      composeLookupIndex,
    );
    expect(protect).not.toMatch(/\bdocker\s+compose\b/u);
  });
});
