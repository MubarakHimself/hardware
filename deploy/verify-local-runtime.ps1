[CmdletBinding()]
param(
  [switch]$KeepArtifacts
)

$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$composeFile = Join-Path $projectRoot "docker-compose.yml"
$runId = [Guid]::NewGuid().ToString("N").Substring(0, 12)
$projectName = "hardware-verify-$runId"
$priorRelease = "verify-$runId-prior"
$candidateRelease = "verify-$runId-candidate"
$temporaryBase = Join-Path ([IO.Path]::GetTempPath()) "hardware-runtime-verification"
$temporaryRoot = Join-Path $temporaryBase $runId
$environmentFile = Join-Path $temporaryRoot "runtime.env"
$backupDirectory = Join-Path $temporaryRoot "backups"
$backupKeyFile = Join-Path $temporaryRoot "backup.key"
$cleanupMarker = Join-Path $temporaryRoot ".hardware-runtime-verification"
$candidateContext = Join-Path $temporaryRoot "candidate-context"
$candidateDockerfile = Join-Path $candidateContext "Dockerfile"
$candidateComposeFile = Join-Path $temporaryRoot "compose.candidate.yml"
$databaseName = "hardware_verify"
$databaseUser = "hardware_verify"
$databasePassword = [Guid]::NewGuid().ToString("N")
$healthToken = ([Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N"))
$sentinelId = [Guid]::NewGuid().ToString("N")
$script:composeProjectTouched = $false

function Assert-DisposableBoundary {
  if ($projectName -notmatch '^hardware-verify-[0-9a-f]{12}$') {
    throw "The disposable Compose project name failed validation."
  }
  $resolvedBase = [IO.Path]::GetFullPath($temporaryBase).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $resolvedRoot = [IO.Path]::GetFullPath($temporaryRoot)
  $expectedPrefix = $resolvedBase + [IO.Path]::DirectorySeparatorChar
  if (
    -not $resolvedRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path -Leaf $resolvedRoot) -ne $runId
  ) {
    throw "The disposable verification directory failed validation."
  }
}

function Get-FreeLoopbackPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Invoke-VerificationCompose([string[]]$Arguments) {
  $script:composeProjectTouched = $true
  & docker compose --file $composeFile --project-name $projectName --env-file $environmentFile @Arguments
  $composeExitCode = $LASTEXITCODE
  if ($composeExitCode -ne 0) {
    throw "Disposable Docker Compose command failed: $($Arguments -join ' ')"
  }
}

function Invoke-CandidateCompose([string[]]$Arguments) {
  $script:composeProjectTouched = $true
  & docker compose --file $composeFile --file $candidateComposeFile `
    --project-name $projectName --env-file $environmentFile @Arguments
  $composeExitCode = $LASTEXITCODE
  if ($composeExitCode -ne 0) {
    throw "Disposable candidate Compose command failed: $($Arguments -join ' ')"
  }
}

function Get-VerificationContainerId([string]$Service) {
  $containerIds = @(& docker compose --file $composeFile --project-name $projectName `
      --env-file $environmentFile ps --all --quiet $Service)
  $composeExitCode = $LASTEXITCODE
  $containerId = $containerIds | Where-Object { $_ } | Select-Object -First 1
  if ($composeExitCode -ne 0 -or -not $containerId) {
    throw "The disposable $Service container could not be identified."
  }
  return $containerId
}

function Invoke-VerificationPsql([string]$Sql) {
  $output = @(& docker compose --file $composeFile --project-name $projectName `
      --env-file $environmentFile exec -T postgres psql --username $databaseUser `
      --dbname $databaseName --tuples-only --no-align --set ON_ERROR_STOP=1 `
      --command $Sql)
  $composeExitCode = $LASTEXITCODE
  if ($composeExitCode -ne 0) { throw "Disposable PostgreSQL verification failed." }
  return @($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
}

function Set-VerificationSentinel([string]$Value) {
  if ($Value -notmatch '^[a-z-]{1,32}$') { throw "The verification sentinel is invalid." }
  $sql = "create table if not exists local_runtime_verification (id text primary key, value text not null); insert into local_runtime_verification (id, value) values ('$sentinelId', '$Value') on conflict (id) do update set value = excluded.value"
  Invoke-VerificationPsql $sql | Out-Null
}

function Assert-VerificationSentinel([string]$Expected) {
  $actual = @(Invoke-VerificationPsql "select value from local_runtime_verification where id = '$sentinelId'")
  if ($actual.Count -ne 1 -or $actual[0] -ne $Expected) {
    throw "Disposable catalog persistence check failed; expected $Expected."
  }
}

function Wait-VerificationReady {
  $headers = @{ Authorization = "Bearer $healthToken" }
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Headers $headers `
        -Uri "http://127.0.0.1:$script:verificationPort/api/health/ready"
      if ($response.StatusCode -eq 200) { return }
    } catch {
      if ($attempt -lt 59) { Start-Sleep -Seconds 3 }
    }
  }
  throw "Disposable Hardware services did not become ready."
}

function Assert-VerificationCatalog {
  $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 `
    -Uri "http://127.0.0.1:$script:verificationPort/api/projects?limit=1"
  if ($response.StatusCode -ne 200 -or $response.Content -notmatch '"data"') {
    throw "Disposable catalog read failed."
  }
}

function Assert-LoopbackPublication {
  $webContainer = Get-VerificationContainerId "web"
  $bindingsJson = (& docker inspect --format "{{json .HostConfig.PortBindings}}" $webContainer)
  if ($LASTEXITCODE -ne 0 -or -not $bindingsJson) { throw "Web port bindings could not be inspected." }
  $bindings = $bindingsJson | ConvertFrom-Json
  $webBinding = @($bindings.'3000/tcp')
  if (
    $webBinding.Count -ne 1 -or
    $webBinding[0].HostIp -ne "127.0.0.1" -or
    [int]$webBinding[0].HostPort -ne $script:verificationPort
  ) {
    throw "The disposable web service was not published exclusively on its selected loopback port."
  }

  foreach ($service in @("postgres", "worker")) {
    $containerId = Get-VerificationContainerId $service
    $serviceBindings = (& docker inspect --format "{{json .HostConfig.PortBindings}}" $containerId)
    if ($LASTEXITCODE -ne 0) { throw "$service port bindings could not be inspected." }
    if ($serviceBindings -and $serviceBindings -ne "{}") {
      throw "The disposable $service service unexpectedly published a host port."
    }
  }
}

function New-EncryptedBackup {
  $output = @(Invoke-VerificationCompose @("run", "--rm", "backup"))
  $createdLine = $output | Where-Object {
    $_ -match '^Encrypted backup created: ([A-Za-z0-9._-]+\.dump\.enc)$'
  } | Select-Object -Last 1
  if (-not $createdLine) { throw "The disposable backup did not report its archive." }
  $archiveName = ([regex]::Match([string]$createdLine, '^Encrypted backup created: (.+)$')).Groups[1].Value
  $archivePath = Join-Path (Join-Path $backupDirectory "daily") $archiveName
  if (
    -not (Test-Path -LiteralPath $archivePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath "$archivePath.sha256" -PathType Leaf)
  ) {
    throw "The disposable encrypted archive or manifest is missing."
  }
  $plaintext = Get-ChildItem -LiteralPath $backupDirectory -Recurse -File -Filter "*.dump" -ErrorAction SilentlyContinue
  if ($plaintext) { throw "A plaintext dump escaped the disposable backup container." }
  return $archiveName
}

function Invoke-DisposableRestore([string]$ArchiveName, [string]$Release) {
  if ($ArchiveName -notmatch '^hardware-[A-Za-z0-9._-]+\.dump\.enc$') {
    throw "The disposable restore archive name is invalid."
  }
  if ($Release -notmatch '^verify-[0-9a-f]{12}-(prior|candidate)$') {
    throw "The disposable restore release is invalid."
  }
  $operationId = [DateTime]::UtcNow.ToString("yyyyMMddHHmmss") + `
    [Guid]::NewGuid().ToString("N").Substring(0, 4)
  $savedRelease = [Environment]::GetEnvironmentVariable("RELEASE_SHA", "Process")
  $savedAction = [Environment]::GetEnvironmentVariable("RESTORE_ACTION", "Process")
  $savedOperation = [Environment]::GetEnvironmentVariable("RESTORE_OPERATION_ID", "Process")
  $savedFile = [Environment]::GetEnvironmentVariable("RESTORE_FILE", "Process")
  try {
    $env:RELEASE_SHA = $Release
    $env:RESTORE_OPERATION_ID = $operationId
    $env:RESTORE_FILE = $ArchiveName
    Invoke-VerificationCompose @("stop", "web", "worker")
    $env:RESTORE_ACTION = "stage"
    Invoke-VerificationCompose @("run", "--rm", "restore")
    Invoke-VerificationCompose @("run", "--rm", "--no-deps", "migrate")
    $env:RESTORE_ACTION = "prepare"
    Invoke-VerificationCompose @("run", "--rm", "restore")
    Invoke-VerificationCompose @("up", "-d", "web", "worker")
    Wait-VerificationReady
    Assert-VerificationCatalog
    $env:RESTORE_ACTION = "commit"
    Invoke-VerificationCompose @("run", "--rm", "restore")
  } finally {
    [Environment]::SetEnvironmentVariable("RELEASE_SHA", $savedRelease, "Process")
    [Environment]::SetEnvironmentVariable("RESTORE_ACTION", $savedAction, "Process")
    [Environment]::SetEnvironmentVariable("RESTORE_OPERATION_ID", $savedOperation, "Process")
    [Environment]::SetEnvironmentVariable("RESTORE_FILE", $savedFile, "Process")
  }
}

Assert-DisposableBoundary
New-Item -ItemType Directory -Force -Path $temporaryRoot, $backupDirectory, $candidateContext | Out-Null
[IO.File]::WriteAllText($cleanupMarker, "disposable=$projectName" + [Environment]::NewLine)
[IO.File]::WriteAllText($backupKeyFile, ([Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")) + [Environment]::NewLine)
$script:verificationPort = Get-FreeLoopbackPort
$composeBackupDirectory = $backupDirectory.Replace('\', '/')
$composeBackupKeyFile = $backupKeyFile.Replace('\', '/')
$environment = @(
  "APP_MODE=local"
  "NEXT_PUBLIC_APP_URL=http://127.0.0.1:$script:verificationPort"
  "HARDWARE_PORT=$script:verificationPort"
  "LOCAL_OWNER_ID=00000000-0000-4000-8000-000000000001"
  "LOCAL_OWNER_NAME=Disposable verifier"
  "POSTGRES_DB=$databaseName"
  "POSTGRES_USER=$databaseUser"
  "POSTGRES_PASSWORD=$databasePassword"
  "DATABASE_URL=postgresql://${databaseUser}:${databasePassword}@postgres:5432/${databaseName}"
  "DATABASE_POOL_MAX=4"
  "DATABASE_SSL=false"
  "DATABASE_STATEMENT_TIMEOUT_MS=15000"
  "YOUTUBE_API_KEY=disposable-verifier-key"
  "GITHUB_TOKEN="
  "SOURCE_HTTP_TIMEOUT_MS=10000"
  "HEALTHCHECK_TOKEN=$healthToken"
  "LOG_LEVEL=warn"
  "WORKER_CONCURRENCY=1"
  "RELEASE_SHA=$priorRelease"
  "HARDWARE_BACKUP_DIR=$composeBackupDirectory"
  "BACKUP_KEY_FILE=$composeBackupKeyFile"
  "BACKUP_RETENTION_DAYS=7"
  "BACKUP_RETENTION_WEEKS=4"
)
[IO.File]::WriteAllLines($environmentFile, $environment)
$verificationProcessEnvironment = @{
  APP_MODE = "local"
  NEXT_PUBLIC_APP_URL = "http://127.0.0.1:$script:verificationPort"
  HARDWARE_PORT = [string]$script:verificationPort
  LOCAL_OWNER_ID = "00000000-0000-4000-8000-000000000001"
  LOCAL_OWNER_NAME = "Disposable verifier"
  POSTGRES_DB = $databaseName
  POSTGRES_USER = $databaseUser
  POSTGRES_PASSWORD = $databasePassword
  DATABASE_URL = "postgresql://${databaseUser}:${databasePassword}@postgres:5432/${databaseName}"
  DATABASE_POOL_MAX = "4"
  DATABASE_SSL = "false"
  DATABASE_STATEMENT_TIMEOUT_MS = "15000"
  YOUTUBE_API_KEY = "disposable-verifier-key"
  GITHUB_TOKEN = ""
  SOURCE_HTTP_TIMEOUT_MS = "10000"
  HEALTHCHECK_TOKEN = $healthToken
  LOG_LEVEL = "warn"
  WORKER_CONCURRENCY = "1"
  RELEASE_SHA = $priorRelease
  HARDWARE_BACKUP_DIR = $composeBackupDirectory
  BACKUP_KEY_FILE = $composeBackupKeyFile
  BACKUP_RETENTION_DAYS = "7"
  BACKUP_RETENTION_WEEKS = "4"
}
$previousProcessEnvironment = @{}
foreach ($name in $verificationProcessEnvironment.Keys) {
  $previousProcessEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  [Environment]::SetEnvironmentVariable($name, [string]$verificationProcessEnvironment[$name], "Process")
}

$verificationPassed = $false
$cleanupFailure = $null
try {
  & docker info --format "{{.ServerVersion}}" *> $null
  if ($LASTEXITCODE -ne 0) { throw "Docker Desktop is not running." }

  Write-Host "Building isolated runtime $projectName..."
  Invoke-VerificationCompose @("build", "migrate", "web", "worker")
  Invoke-VerificationCompose @("up", "-d", "--wait", "--wait-timeout", "240", "web", "worker")
  Wait-VerificationReady
  Assert-VerificationCatalog
  Assert-LoopbackPublication

  Set-VerificationSentinel "before-replacement"
  Invoke-VerificationCompose @("stop", "web", "worker", "postgres")
  Invoke-VerificationCompose @("up", "-d", "--force-recreate", "--wait", "postgres")
  Assert-VerificationSentinel "before-replacement"
  Invoke-VerificationCompose @("up", "-d", "web", "worker")
  Wait-VerificationReady

  Set-VerificationSentinel "backed-up"
  $archiveName = New-EncryptedBackup
  Set-VerificationSentinel "after-backup"
  Invoke-DisposableRestore $archiveName $priorRelease
  Assert-VerificationSentinel "backed-up"

  [IO.File]::WriteAllLines($candidateDockerfile, @(
      "FROM hardware:$priorRelease"
      "LABEL hardware.verification.candidate=$runId"
    ))
  & docker build --file $candidateDockerfile --tag "hardware:$candidateRelease" $candidateContext
  if ($LASTEXITCODE -ne 0) { throw "The disposable candidate image could not be built." }
  [IO.File]::WriteAllLines($candidateComposeFile, @(
      "services:"
      "  web:"
      "    command: [`"node`", `"-e`", `"process.exit(42)`"]"
      "    restart: `"no`""
    ))

  Invoke-VerificationCompose @("stop", "web", "worker")
  Set-VerificationSentinel "failed-candidate"
  $savedRelease = [Environment]::GetEnvironmentVariable("RELEASE_SHA", "Process")
  try {
    $env:RELEASE_SHA = $candidateRelease
    Invoke-CandidateCompose @("up", "-d", "--no-deps", "--force-recreate", "web")
  } finally {
    [Environment]::SetEnvironmentVariable("RELEASE_SHA", $savedRelease, "Process")
  }
  Start-Sleep -Seconds 2
  $failedWeb = Get-VerificationContainerId "web"
  $candidateState = (& docker inspect --format "{{.State.Status}}:{{.State.ExitCode}}" $failedWeb)
  if ($LASTEXITCODE -ne 0 -or $candidateState -ne "exited:42") {
    throw "The disposable failed candidate did not fail as expected."
  }

  Invoke-DisposableRestore $archiveName $priorRelease
  Assert-VerificationSentinel "backed-up"
  $runningWeb = Get-VerificationContainerId "web"
  $runningImage = (& docker inspect --format "{{.Image}}" $runningWeb)
  $priorImage = (& docker image inspect --format "{{.Id}}" "hardware:$priorRelease")
  if ($LASTEXITCODE -ne 0 -or -not $runningImage -or $runningImage -ne $priorImage) {
    throw "The prior image was not restored after the disposable candidate failure."
  }
  Wait-VerificationReady
  Assert-VerificationCatalog

  $verificationPassed = $true
  Write-Host "Disposable runtime verification passed: loopback, persistence, encrypted restore, and failed-candidate rollback."
} finally {
  try {
    if ($KeepArtifacts) {
      Write-Warning "Disposable artifacts were retained at $temporaryRoot under Compose project $projectName."
    } else {
      try {
        Assert-DisposableBoundary
        if ($script:composeProjectTouched -and (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
          & docker compose --file $composeFile --project-name $projectName `
            --env-file $environmentFile down --volumes --remove-orphans
          if ($LASTEXITCODE -ne 0) { throw "The isolated Compose project could not be removed." }
        }
        & docker image rm "hardware:$candidateRelease" "hardware:$priorRelease" 2>$null | Out-Null
      } catch {
        $cleanupFailure = $_.Exception.Message
        Write-Warning "Disposable Docker cleanup needs attention; artifacts were retained at $temporaryRoot. Cause: $cleanupFailure"
      }
      if (-not $cleanupFailure) {
        Assert-DisposableBoundary
        if (-not (Test-Path -LiteralPath $cleanupMarker -PathType Leaf)) {
          throw "Refusing to remove an unmarked verification directory."
        }
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
      }
    }
  } finally {
    foreach ($name in $verificationProcessEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousProcessEnvironment[$name], "Process")
    }
  }
}

if ($cleanupFailure) { throw "Disposable runtime verification cleanup failed: $cleanupFailure" }
if (-not $verificationPassed) { throw "Disposable runtime verification did not complete." }
