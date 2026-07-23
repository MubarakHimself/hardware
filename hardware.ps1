[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("setup", "start", "stop", "status", "backup", "restore", "update", "install-backup-task")]
  [string]$Command = "status",

  [string]$RestoreFile,
  [string]$YouTubeApiKey,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = $MyInvocation.MyCommand.Path
$composeFile = [IO.Path]::GetFullPath((Join-Path $scriptRoot "docker-compose.yml"))
$composeProjectName = "hardware"
$environmentFile = Join-Path $scriptRoot ".env.local"
$runtimeDirectory = Join-Path $scriptRoot ".hardware"
$backupDirectory = Join-Path $scriptRoot "backups"
$backupKeyFile = Join-Path $runtimeDirectory "backup.key"

function New-HexSecret([int]$ByteCount) {
  $bytes = New-Object byte[] $ByteCount
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Protect-LocalSecretFile([string]$Path) {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $identity,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
  } catch {
    Write-Warning "Could not restrict local secret permissions for $Path."
  }
}

function Get-EnvironmentValue([string]$Name) {
  if (-not (Test-Path -LiteralPath $environmentFile)) { return $null }
  $line = Get-Content -LiteralPath $environmentFile | Where-Object { $_ -like "$Name=*" } | Select-Object -Last 1
  if (-not $line) { return $null }
  return $line.Substring($Name.Length + 1)
}

function Resolve-HardwarePath([string]$ConfiguredPath, [string]$DefaultPath) {
  if ([string]::IsNullOrWhiteSpace($ConfiguredPath)) { return $DefaultPath }
  if ([IO.Path]::IsPathRooted($ConfiguredPath)) {
    return [IO.Path]::GetFullPath($ConfiguredPath)
  }
  return [IO.Path]::GetFullPath((Join-Path $scriptRoot $ConfiguredPath))
}

function Get-BackupDirectory {
  return Resolve-HardwarePath (Get-EnvironmentValue "HARDWARE_BACKUP_DIR") $backupDirectory
}

function Get-BackupKeyFile {
  return Resolve-HardwarePath (Get-EnvironmentValue "BACKUP_KEY_FILE") $backupKeyFile
}

function Assert-BackupKeyAvailable {
  $configuredBackupKeyFile = Get-BackupKeyFile
  if (-not (Test-Path -LiteralPath $configuredBackupKeyFile -PathType Leaf)) {
    throw "The configured backup encryption key is missing at $configuredBackupKeyFile. Recover that key before continuing so existing backups remain usable."
  }
}

function Set-EnvironmentValue([string]$Name, [string]$Value) {
  $lines = Get-Content -LiteralPath $environmentFile
  $replaced = $false
  $updated = foreach ($line in $lines) {
    if ($line -like "$Name=*") {
      $replaced = $true
      "$Name=$Value"
    } else { $line }
  }
  if (-not $replaced) { $updated += "$Name=$Value" }
  [IO.File]::WriteAllLines($environmentFile, $updated)
}

function Invoke-Compose([string[]]$Arguments) {
  if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
    throw "The Hardware Docker Compose file is missing at $composeFile."
  }
  $retentionDays = Get-EnvironmentValue "BACKUP_RETENTION_DAYS"
  if ([string]::IsNullOrWhiteSpace($retentionDays)) { $retentionDays = "7" }
  $retentionWeeks = Get-EnvironmentValue "BACKUP_RETENTION_WEEKS"
  if ([string]::IsNullOrWhiteSpace($retentionWeeks)) { $retentionWeeks = "4" }
  $composeFileOverrides = @{
    COMPOSE_FILE = $composeFile
    COMPOSE_PROJECT_NAME = $composeProjectName
    HARDWARE_BACKUP_DIR = Get-BackupDirectory
    BACKUP_KEY_FILE = Get-BackupKeyFile
    BACKUP_RETENTION_DAYS = $retentionDays
    BACKUP_RETENTION_WEEKS = $retentionWeeks
  }
  $previousComposeEnvironment = @{}
  foreach ($name in $composeFileOverrides.Keys) {
    $previousComposeEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, [string]$composeFileOverrides[$name], "Process")
  }

  $invokeComposeExitCode = 1
  try {
    & docker compose --file $composeFile --project-name $composeProjectName --env-file $environmentFile @Arguments
    $invokeComposeExitCode = $LASTEXITCODE
  } finally {
    foreach ($name in $composeFileOverrides.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousComposeEnvironment[$name], "Process")
    }
  }
  if ($invokeComposeExitCode -ne 0) { throw "Docker Compose failed." }
}

function Assert-Docker {
  & docker info --format "{{.ServerVersion}}" *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is not running. Start Docker Desktop and try again."
  }
}

function Get-LatestBackup {
  $configuredBackupDirectory = Get-BackupDirectory
  return Get-ChildItem -LiteralPath (Join-Path $configuredBackupDirectory "daily") -Filter "hardware-*.dump.enc" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

function Get-HardwareOrigin {
  $value = Get-EnvironmentValue "NEXT_PUBLIC_APP_URL"
  if (-not $value) { throw "NEXT_PUBLIC_APP_URL is unavailable." }
  try { $origin = [Uri]$value } catch { throw "NEXT_PUBLIC_APP_URL is invalid." }
  if (
    -not $origin.IsAbsoluteUri -or
    $origin.Scheme -ne "http" -or
    $origin.Host -ne "127.0.0.1" -or
    $origin.UserInfo -or
    $origin.AbsolutePath -ne "/" -or
    $origin.Query -or
    $origin.Fragment
  ) {
    throw "NEXT_PUBLIC_APP_URL must be an HTTP origin on 127.0.0.1 with no path, query, or credentials."
  }
  $port = Get-EnvironmentValue "HARDWARE_PORT"
  if (-not $port -or $port -notmatch '^\d{1,5}$' -or [int]$port -lt 1 -or [int]$port -gt 65535) {
    throw "HARDWARE_PORT must be a valid TCP port."
  }
  if ($origin.Port -ne [int]$port) {
    throw "NEXT_PUBLIC_APP_URL and HARDWARE_PORT must use the same port."
  }
  return $origin.GetLeftPart([UriPartial]::Authority)
}

function Wait-HardwareReady {
  $origin = Get-HardwareOrigin
  $healthToken = Get-EnvironmentValue "HEALTHCHECK_TOKEN"
  if (-not $healthToken) { throw "The local healthcheck token is unavailable." }
  $headers = @{ Authorization = "Bearer $healthToken" }
  for ($attempt = 0; $attempt -lt 36; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Headers $headers -Uri "$origin/api/health/ready"
      if ($response.StatusCode -eq 200) { return }
    } catch {
      if ($attempt -lt 35) { Start-Sleep -Seconds 5 }
    }
  }
  throw "Hardware did not become ready. Run .\hardware.ps1 status for details."
}

function Assert-CatalogReadable {
  $origin = Get-HardwareOrigin
  $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri "$origin/api/projects?limit=1"
  if ($response.StatusCode -ne 200 -or $response.Content -notmatch '"data"') {
    throw "The local catalog smoke test failed."
  }
}

function Protect-CurrentImageForRollback {
  $containerIds = @(Invoke-Compose @("ps", "--quiet", "web"))
  $containerId = $containerIds | Where-Object { $_ } | Select-Object -First 1
  if (-not $containerId) {
    throw "The running web container could not be identified for rollback protection."
  }
  $imageId = (& docker inspect --format "{{.Image}}" $containerId)
  if ($LASTEXITCODE -ne 0 -or -not $imageId) {
    throw "The running web image could not be identified for rollback protection."
  }
  & docker image tag $imageId "hardware:rollback"
  if ($LASTEXITCODE -ne 0) { throw "The current image could not be tagged for rollback." }
}

function Get-DatabaseSchemaVersion {
  $databaseUser = Get-EnvironmentValue "POSTGRES_USER"
  $databaseName = Get-EnvironmentValue "POSTGRES_DB"
  if ($databaseUser -notmatch '^[A-Za-z0-9_]+$' -or $databaseName -notmatch '^[A-Za-z0-9_]+$') {
    throw "The PostgreSQL identifiers are invalid."
  }
  $version = (Invoke-Compose @("exec", "-T", "postgres", "psql", "--username", $databaseUser, "--dbname", $databaseName, "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", "select coalesce((select hash from drizzle.__drizzle_migrations order by created_at desc limit 1), 'none')"))
  if (-not $version) { throw "The database schema version could not be read." }
  return ([string]$version).Trim()
}

function Assert-SafePostgresIdentifier([string]$Label, [string]$Value) {
  if (
    [string]::IsNullOrWhiteSpace($Value) -or
    $Value.Length -gt 63 -or
    $Value -notmatch '^[A-Za-z0-9_]+$'
  ) {
    throw "$Label is not a safe PostgreSQL identifier."
  }
}

function Get-PostgresDatabaseNames {
  $databaseUser = Get-EnvironmentValue "POSTGRES_USER"
  Assert-SafePostgresIdentifier "POSTGRES_USER" $databaseUser
  $databaseNames = @(Invoke-Compose @(
      "exec", "-T", "postgres", "psql",
      "--username", $databaseUser, "--dbname", "postgres", "--tuples-only", "--no-align",
      "--set", "ON_ERROR_STOP=1", "--command", "select datname from pg_database order by datname"
    ))
  return @($databaseNames | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
}

function Test-ExactDatabaseName([string[]]$Names, [string]$Name) {
  return @($Names | Where-Object {
      [string]::Equals($_, $Name, [StringComparison]::Ordinal)
    }).Count -gt 0
}

function New-RecoveryDatabaseName(
  [string]$DatabaseName,
  [ValidateSet("failed", "held")][string]$Kind,
  [string]$OperationId,
  [string[]]$ExistingNames
) {
  if ($OperationId -notmatch '^[A-Za-z0-9]{8,24}$') {
    throw "The restore operation ID is invalid for startup recovery."
  }
  $candidate = "${DatabaseName}_${Kind}_${OperationId}"
  Assert-SafePostgresIdentifier "Recovery database name" $candidate
  if (-not (Test-ExactDatabaseName $ExistingNames $candidate)) { return $candidate }

  for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
    $recoveryId = [DateTime]::UtcNow.ToString("yyyyMMddHHmmss") + (New-HexSecret 2)
    $candidate = "${DatabaseName}_${Kind}_${recoveryId}"
    Assert-SafePostgresIdentifier "Recovery database name" $candidate
    if (-not (Test-ExactDatabaseName $ExistingNames $candidate)) { return $candidate }
  }
  throw "A distinct database name could not be reserved for startup recovery."
}

function Rename-PostgresDatabase([string]$CurrentName, [string]$NewName) {
  $databaseUser = Get-EnvironmentValue "POSTGRES_USER"
  Assert-SafePostgresIdentifier "POSTGRES_USER" $databaseUser
  Assert-SafePostgresIdentifier "Current database name" $CurrentName
  Assert-SafePostgresIdentifier "New database name" $NewName
  $sql = "alter database `"$CurrentName`" rename to `"$NewName`""
  try {
    Invoke-Compose @(
      "exec", "-T", "postgres", "psql",
      "--username", $databaseUser, "--dbname", "postgres", "--set", "ON_ERROR_STOP=1",
      "--command", $sql
    ) | Out-Null
  } catch {
    throw "PostgreSQL could not rename $CurrentName during startup recovery. Cause: $($_.Exception.Message)"
  }
}

function Stop-PostgresDatabaseConnections([string]$DatabaseName) {
  $databaseUser = Get-EnvironmentValue "POSTGRES_USER"
  Assert-SafePostgresIdentifier "POSTGRES_USER" $databaseUser
  Assert-SafePostgresIdentifier "Database name" $DatabaseName
  $sql = "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DatabaseName' and pid <> pg_backend_pid()"
  try {
    Invoke-Compose @(
      "exec", "-T", "postgres", "psql",
      "--username", $databaseUser, "--dbname", "postgres", "--set", "ON_ERROR_STOP=1",
      "--command", $sql
    ) | Out-Null
  } catch {
    throw "PostgreSQL connections could not be stopped for startup recovery. Cause: $($_.Exception.Message)"
  }
}

function Recover-InterruptedRestore {
  $databaseName = Get-EnvironmentValue "POSTGRES_DB"
  Assert-SafePostgresIdentifier "POSTGRES_DB" $databaseName
  if ($databaseName.Length -gt 24) {
    throw "POSTGRES_DB is too long for safe restore recovery."
  }

  $databaseNames = @(Get-PostgresDatabaseNames)
  $candidatePattern = '^' + [regex]::Escape("${databaseName}_before_") + `
    '(?<operation>[0-9]{14}[A-Fa-f0-9]{4})$'
  $candidates = @($databaseNames | ForEach-Object {
      if ($_ -match $candidatePattern) {
        [pscustomobject]@{ Name = $_; OperationId = $Matches.operation }
      }
    } | Sort-Object OperationId -Descending)
  if ($candidates.Count -eq 0) { return $false }

  # No supported writer may remain connected while the retained database is reactivated.
  Invoke-Compose @("stop", "web", "worker", "migrate")
  $databaseNames = @(Get-PostgresDatabaseNames)
  $candidates = @($databaseNames | ForEach-Object {
      if ($_ -match $candidatePattern) {
        [pscustomobject]@{ Name = $_; OperationId = $Matches.operation }
      }
    } | Sort-Object OperationId -Descending)
  if ($candidates.Count -eq 0) { return $false }

  $newest = $candidates[0]
  foreach ($older in @($candidates | Select-Object -Skip 1)) {
    $heldName = New-RecoveryDatabaseName $databaseName "held" $older.OperationId $databaseNames
    Rename-PostgresDatabase $older.Name $heldName
    $databaseNames = @($databaseNames | Where-Object {
        -not [string]::Equals($_, $older.Name, [StringComparison]::Ordinal)
      }) + $heldName
  }

  $preservedInterruptedDatabase = $null
  if (Test-ExactDatabaseName $databaseNames $databaseName) {
    $failedName = New-RecoveryDatabaseName $databaseName "failed" $newest.OperationId $databaseNames
    Stop-PostgresDatabaseConnections $databaseName
    Rename-PostgresDatabase $databaseName $failedName
    $preservedInterruptedDatabase = $failedName
  }
  Rename-PostgresDatabase $newest.Name $databaseName
  if ($preservedInterruptedDatabase) {
    Write-Warning "Recovered the retained pre-restore catalog from interrupted operation $($newest.OperationId). The interrupted catalog was preserved as $preservedInterruptedDatabase for diagnosis."
  } else {
    Write-Warning "Recovered the retained pre-restore catalog from interrupted operation $($newest.OperationId)."
  }
  return $true
}

function Record-LocalOperation(
  [string]$Action,
  [string]$Status,
  [string]$BeforeRelease,
  [string]$AfterRelease,
  [string]$BeforeSchema,
  [string]$AfterSchema
) {
  foreach ($value in @($Action, $Status, $BeforeRelease, $AfterRelease, $BeforeSchema, $AfterSchema)) {
    if ($value -notmatch '^[A-Za-z0-9._:-]{1,128}$') {
      throw "A local operation audit value was invalid."
    }
  }
  $databaseUser = Get-EnvironmentValue "POSTGRES_USER"
  $databaseName = Get-EnvironmentValue "POSTGRES_DB"
  $ownerId = Get-EnvironmentValue "LOCAL_OWNER_ID"
  if ($databaseUser -notmatch '^[A-Za-z0-9_]+$' -or $databaseName -notmatch '^[A-Za-z0-9_]+$') {
    throw "The PostgreSQL identifiers are invalid."
  }
  if (-not [string]::Equals(
      $ownerId,
      "00000000-0000-4000-8000-000000000001",
      [StringComparison]::Ordinal
    )) {
    throw "LOCAL_OWNER_ID must equal 00000000-0000-4000-8000-000000000001 for this single-user installation."
  }
  $targetId = "$Action`:$AfterRelease"
  $sql = "insert into audit_events (actor_user_id, action, target_type, target_id, correlation_id, after_summary) select id, '$Action', 'local_runtime', '$targetId', gen_random_uuid(), jsonb_build_object('status', '$Status', 'beforeRelease', '$BeforeRelease', 'afterRelease', '$AfterRelease', 'beforeSchema', '$BeforeSchema', 'afterSchema', '$AfterSchema') from users where id = '$ownerId'::uuid"
  try {
    Invoke-Compose @(
      "exec", "-T", "postgres", "psql", "--username", $databaseUser,
      "--dbname", $databaseName, "--set", "ON_ERROR_STOP=1", "--command", $sql
    ) | Out-Null
  } catch {
    throw "The local operation audit event could not be recorded. Cause: $($_.Exception.Message)"
  }
}

function Initialize-Hardware {
  New-Item -ItemType Directory -Force -Path $runtimeDirectory, $backupDirectory | Out-Null

  $alreadyConfigured = Test-Path -LiteralPath $environmentFile
  $configuredBackupDirectory = if ($alreadyConfigured) { Get-BackupDirectory } else { $backupDirectory }
  $configuredBackupKeyFile = if ($alreadyConfigured) { Get-BackupKeyFile } else { $backupKeyFile }
  New-Item -ItemType Directory -Force -Path $configuredBackupDirectory | Out-Null
  if ($alreadyConfigured -and -not (Test-Path -LiteralPath $configuredBackupKeyFile -PathType Leaf)) {
    throw "The existing installation's configured backup key is missing at $configuredBackupKeyFile. Recover it before continuing so older backups remain usable."
  }
  if (-not (Test-Path -LiteralPath $configuredBackupKeyFile -PathType Leaf)) {
    $configuredKeyDirectory = Split-Path -Parent $configuredBackupKeyFile
    New-Item -ItemType Directory -Force -Path $configuredKeyDirectory | Out-Null
    [IO.File]::WriteAllText($configuredBackupKeyFile, (New-HexSecret 48) + [Environment]::NewLine)
  }
  Protect-LocalSecretFile $configuredBackupKeyFile

  if ($alreadyConfigured) {
    Protect-LocalSecretFile $environmentFile
    Write-Host "Hardware is already configured at $environmentFile"
    return
  }

  if (-not $YouTubeApiKey) {
    $YouTubeApiKey = Read-Host "YouTube Data API key"
  }
  if ([string]::IsNullOrWhiteSpace($YouTubeApiKey)) {
    throw "A YouTube Data API key is required for imports and channel sync."
  }
  if ($YouTubeApiKey -match "[\r\n]") { throw "The YouTube API key is invalid." }

  $databasePassword = New-HexSecret 32
  $healthToken = New-HexSecret 48
  $release = "local"
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $detectedRelease = (& git -C $scriptRoot rev-parse --verify HEAD 2>$null)
    if ($detectedRelease) { $release = $detectedRelease }
  }

  $content = @(
    "APP_MODE=local"
    "NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000"
    "HARDWARE_PORT=3000"
    "LOCAL_OWNER_ID=00000000-0000-4000-8000-000000000001"
    "LOCAL_OWNER_NAME=Local owner"
    "POSTGRES_DB=hardware"
    "POSTGRES_USER=hardware"
    "POSTGRES_PASSWORD=$databasePassword"
    "DATABASE_URL=postgresql://hardware:$databasePassword@postgres:5432/hardware"
    "DATABASE_POOL_MAX=8"
    "DATABASE_SSL=false"
    "DATABASE_STATEMENT_TIMEOUT_MS=15000"
    "YOUTUBE_API_KEY=$YouTubeApiKey"
    "GITHUB_TOKEN="
    "SOURCE_HTTP_TIMEOUT_MS=10000"
    "HEALTHCHECK_TOKEN=$healthToken"
    "LOG_LEVEL=info"
    "WORKER_CONCURRENCY=2"
    "RELEASE_SHA=$release"
    "HARDWARE_BACKUP_DIR=./backups"
    "BACKUP_KEY_FILE=./.hardware/backup.key"
    "BACKUP_RETENTION_DAYS=7"
    "BACKUP_RETENTION_WEEKS=4"
  ) -join [Environment]::NewLine
  [IO.File]::WriteAllText($environmentFile, $content + [Environment]::NewLine)
  Protect-LocalSecretFile $environmentFile
  Write-Host "Hardware local configuration created."
}

function Start-Hardware {
  if (-not (Test-Path -LiteralPath $environmentFile)) { Initialize-Hardware }
  Assert-BackupKeyAvailable
  Assert-Docker
  Invoke-Compose @("up", "-d", "--wait", "postgres")
  $recoveredInterruptedRestore = Recover-InterruptedRestore
  $release = Get-EnvironmentValue "RELEASE_SHA"
  if (-not $release) { $release = "local" }
  & docker image inspect "hardware:$release" *> $null
  $startArguments = if ($LASTEXITCODE -eq 0) {
    @("up", "-d", "web", "worker")
  } else {
    @("up", "-d", "--build", "web", "worker")
  }
  Invoke-Compose $startArguments
  Wait-HardwareReady
  Assert-CatalogReadable

  $latest = Get-LatestBackup
  if (-not $latest -or $latest.LastWriteTime -lt (Get-Date).AddDays(-1)) {
    Invoke-Compose @("run", "--rm", "backup")
  }

  $origin = Get-HardwareOrigin
  Write-Host "Hardware is ready at $origin"
  if (-not $NoOpen) { Start-Process $origin }
}

function Stop-Hardware {
  if (-not (Test-Path -LiteralPath $environmentFile)) { return }
  Assert-Docker
  Invoke-Compose @("stop", "web", "worker", "postgres")
  Write-Host "Hardware stopped. Your database volume was preserved."
}

function Show-HardwareStatus {
  if (-not (Test-Path -LiteralPath $environmentFile)) {
    Write-Host "Hardware is not configured. Run .\hardware.ps1 setup."
    return
  }
  Assert-Docker
  Invoke-Compose @("ps")
  $latest = Get-LatestBackup
  if ($latest) { Write-Host "Latest backup: $($latest.Name) at $($latest.LastWriteTime)" }
  else { Write-Warning "No local backup exists yet." }
}

function Backup-Hardware {
  if (-not (Test-Path -LiteralPath $environmentFile)) { throw "Run setup first." }
  Assert-BackupKeyAvailable
  Assert-Docker
  Invoke-Compose @("up", "-d", "postgres") | Out-Host
  $output = Invoke-Compose @("run", "--rm", "backup")
  $createdLine = $output | Where-Object { $_ -match '^Encrypted backup created: ([A-Za-z0-9._-]+\.dump\.enc)$' } | Select-Object -Last 1
  if (-not $createdLine) { throw "The backup completed without reporting its verified archive." }
  $backupName = ([regex]::Match([string]$createdLine, '^Encrypted backup created: (.+)$')).Groups[1].Value
  $backupPath = Join-Path (Join-Path (Get-BackupDirectory) "daily") $backupName
  if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
    throw "The verified backup archive is not visible on the host."
  }
  Write-Host $createdLine
  return Get-Item -LiteralPath $backupPath
}

function Invoke-RestoreAction([string]$Action, [string]$OperationId, [string]$BackupName) {
  $env:RESTORE_ACTION = $Action
  $env:RESTORE_OPERATION_ID = $OperationId
  $env:RESTORE_FILE = $BackupName
  try {
    Invoke-Compose @("run", "--rm", "restore")
  } finally {
    Remove-Item Env:RESTORE_ACTION -ErrorAction SilentlyContinue
    Remove-Item Env:RESTORE_OPERATION_ID -ErrorAction SilentlyContinue
    Remove-Item Env:RESTORE_FILE -ErrorAction SilentlyContinue
  }
}

function Invoke-VerifiedRestore([string]$BackupName, [switch]$UsePriorImage) {
  $operationRelease = Get-EnvironmentValue "RELEASE_SHA"
  if (-not $operationRelease) { $operationRelease = "local" }
  $operationSchema = Get-DatabaseSchemaVersion
  Invoke-Compose @("stop", "web", "worker")
  Invoke-Compose @("up", "-d", "postgres")
  $operationId = [DateTime]::UtcNow.ToString("yyyyMMddHHmmss") + (New-HexSecret 2)
  $staged = $false
  try {
    Invoke-RestoreAction "stage" $operationId $BackupName
    $staged = $true
    Invoke-Compose @("run", "--rm", "--no-deps", "migrate")
    Invoke-RestoreAction "prepare" $operationId $BackupName
    $startArguments = if ($UsePriorImage) {
      @("up", "-d", "--no-build", "web", "worker")
    } else {
      @("up", "-d", "web", "worker")
    }
    Invoke-Compose $startArguments
    Wait-HardwareReady
    Assert-CatalogReadable
    $restoredSchema = Get-DatabaseSchemaVersion
    $successAction = if ($UsePriorImage) {
      "local.update_rollback_succeeded"
    } else {
      "local.restore_succeeded"
    }
    Record-LocalOperation $successAction "succeeded" $operationRelease $operationRelease $operationSchema $restoredSchema
    Invoke-RestoreAction "commit" $operationId $BackupName
  } catch {
    $restoreError = $_.Exception.Message
    Invoke-Compose @("stop", "web", "worker")
    if ($staged) {
      Invoke-RestoreAction "rollback" $operationId $BackupName
    }
    $restartArguments = if ($UsePriorImage) {
      @("up", "-d", "--no-build", "web", "worker")
    } else {
      @("up", "-d", "web", "worker")
    }
    Invoke-Compose $restartArguments
    Wait-HardwareReady
    Assert-CatalogReadable
    try {
      $restoredSchema = Get-DatabaseSchemaVersion
      Record-LocalOperation "local.restore_failed" "failed" $operationRelease $operationRelease $operationSchema $restoredSchema
    } catch {
      Write-Warning "The failed restore could not be added to Activity."
    }
    throw "Restore validation failed; the original catalog was restarted. Cause: $restoreError"
  }
}

function Restore-Hardware {
  if (-not $RestoreFile) { throw "Pass -RestoreFile with a backup basename." }
  if ([IO.Path]::GetFileName($RestoreFile) -ne $RestoreFile -or $RestoreFile -notmatch '^hardware-[A-Za-z0-9._-]+\.dump\.enc$') {
    throw "RestoreFile must be a Hardware backup basename, not a path."
  }
  $answer = Read-Host "Restore $RestoreFile and replace the current local database? Type RESTORE"
  if ($answer -ne "RESTORE") { throw "Restore cancelled." }
  Assert-BackupKeyAvailable
  Assert-Docker
  Invoke-VerifiedRestore $RestoreFile
  Write-Host "Restore completed and Hardware restarted."
}

function Update-Hardware {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required for the update command. Install Git for Windows or replace the project files through your trusted distribution method."
  }
  Assert-Docker
  Wait-HardwareReady
  Assert-CatalogReadable
  $previousRelease = Get-EnvironmentValue "RELEASE_SHA"
  if (-not $previousRelease) { $previousRelease = "local" }
  $previousSchema = Get-DatabaseSchemaVersion
  Protect-CurrentImageForRollback
  $preUpdateBackup = $null
  $migrationMayHaveRun = $false
  $attemptedRelease = "unknown"
  try {
    Invoke-Compose @("stop", "web", "worker")
    $preUpdateBackup = Backup-Hardware
    $remotes = @(& git -C $scriptRoot remote 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "The local Git repository could not be inspected." }
    $remote = $remotes | Where-Object { $_ } | Select-Object -First 1
    if ($remote) {
      & git -C $scriptRoot pull --ff-only
      if ($LASTEXITCODE -ne 0) { throw "Git update failed; the backup remains available." }
    }
    $release = (& git -C $scriptRoot rev-parse --verify HEAD 2>$null)
    if (-not $release) { $release = "local" }
    $attemptedRelease = $release
    $env:RELEASE_SHA = $release
    Invoke-Compose @("build", "migrate", "web", "worker")
    $migrationMayHaveRun = $true
    Invoke-Compose @("run", "--rm", "--no-deps", "migrate")
    Invoke-Compose @("up", "-d", "web", "worker")
    Wait-HardwareReady
    Assert-CatalogReadable
    $currentSchema = Get-DatabaseSchemaVersion
    Record-LocalOperation "local.update_succeeded" "succeeded" $previousRelease $release $previousSchema $currentSchema
    Set-EnvironmentValue "RELEASE_SHA" $release
  } catch {
    $updateError = $_.Exception.Message
    & docker image tag "hardware:rollback" "hardware:$previousRelease"
    if ($LASTEXITCODE -ne 0) {
      throw "Hardware update failed and the protected prior image could not be retagged. Cause: $updateError"
    }
    $env:RELEASE_SHA = $previousRelease
    Set-EnvironmentValue "RELEASE_SHA" $previousRelease
    if ($migrationMayHaveRun -and $preUpdateBackup) {
      Invoke-VerifiedRestore $preUpdateBackup.Name -UsePriorImage
    } else {
      Invoke-Compose @("up", "-d", "--no-build", "web", "worker")
      Wait-HardwareReady
      Assert-CatalogReadable
    }
    try {
      $restoredSchema = Get-DatabaseSchemaVersion
      Record-LocalOperation "local.update_failed" "failed" $previousRelease $attemptedRelease $previousSchema $restoredSchema
    } catch {
      Write-Warning "The failed update could not be added to Activity."
    }
    throw "Hardware update failed and the prior healthy release was restored. Cause: $updateError"
  } finally {
    Remove-Item Env:RELEASE_SHA -ErrorAction SilentlyContinue
  }
  Write-Host "Hardware updated. The pre-update backup is available for recovery."
}

function Install-BackupTask {
  $taskName = "Hardware Daily Backup"
  $command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" backup"
  & schtasks.exe /Create /F /SC DAILY /ST 20:00 /TN $taskName /TR $command
  if ($LASTEXITCODE -ne 0) { throw "Windows could not create the daily backup task." }
  Write-Host "Daily backup task installed for 20:00 while Docker Desktop is available."
}

function Invoke-WithOperationLock([scriptblock]$Action) {
  $mutex = New-Object Threading.Mutex($false, "Local\Hardware.PersonalLocal.Operation")
  $acquired = $false
  try {
    try { $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(2)) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
      throw "Another Hardware setup, start, stop, backup, restore, or update operation is already running."
    }
    & $Action
  } finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

Set-Location $scriptRoot
switch ($Command) {
  "setup" { Invoke-WithOperationLock { Initialize-Hardware } }
  "start" { Invoke-WithOperationLock { Start-Hardware } }
  "stop" { Invoke-WithOperationLock { Stop-Hardware } }
  "status" { Show-HardwareStatus }
  "backup" { Invoke-WithOperationLock { Backup-Hardware | Out-Null } }
  "restore" { Invoke-WithOperationLock { Restore-Hardware } }
  "update" { Invoke-WithOperationLock { Update-Hardware } }
  "install-backup-task" { Invoke-WithOperationLock { Install-BackupTask } }
}
