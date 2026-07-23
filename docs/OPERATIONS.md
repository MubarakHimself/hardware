# Hardware Personal Local operations

Hardware v1.1 is a single-owner application running on one Windows desktop.
Docker Compose provides PostgreSQL, migrations, the web process, and Graphile
Worker. Only the web UI is published, and only on IPv4 loopback.
The supported interface is a desktop browser at `1024px` wide or larger. There
is no mobile or tablet UI in this release.

## 1. Trust boundary

- Open Hardware only through `http://127.0.0.1:3000` or the configured
  loopback port.
- PostgreSQL and Graphile Worker have no host ports.
- There is no user login. Any request that reaches the web process is treated as
  the local owner, so public, LAN, tunnel, and VPS exposure are prohibited.
- Mutations require an HTTP loopback Origin on the configured port. Standard
  loopback aliases are accepted; Host validation rejects non-loopback requests.
- SSRF protection, URL credential rejection, payload limits, rate limits,
  correlation IDs, audit events, and probe authentication remain active.
- Local malware and privileged browser extensions are inside this trust model;
  loopback binding is not a sandbox from software already running as the user.

An automated Compose test must continue proving that the only published port
has host IP `127.0.0.1`.

## 2. First setup

Install current Docker Desktop, PowerShell, and Git for Windows (for the
supported update command), then run:

```powershell
.\hardware.ps1 setup
.\hardware.ps1 start
```

Setup requests the YouTube Data API key and creates:

- `.env.local` with randomly generated PostgreSQL and probe credentials;
- `.hardware/backup.key`, containing a random local encryption key;
- `backups/daily` and `backups/weekly` when the first backup runs.

Those are the defaults. To relocate encrypted archives or their key, edit
`HARDWARE_BACKUP_DIR` or `BACKUP_KEY_FILE` in `.env.local` using an unquoted
relative path beside the project or an absolute Windows path. The launcher
uses `.env.local` as the authority for these settings and does not let an
inherited shell variable silently redirect backup or restore operations.

Do not commit, synchronize, email, or paste `.env.local` or the backup key. A
GitHub token is optional but recommended for larger repository refresh volumes.

Hardware uses the official YouTube Data API. It fetches channel, uploads-list,
video, and description metadata only. It never downloads video, scrapes the
YouTube UI, or requests captions.

## 3. Start, stop, and status

```powershell
.\hardware.ps1 start
.\hardware.ps1 start -NoOpen
.\hardware.ps1 status
.\hardware.ps1 stop
```

`start` builds the configured release image when that tag is absent (otherwise
it reuses the existing image), applies forward migrations, waits for liveness,
creates a backup if the newest daily copy is stale, and opens the desktop
browser. `stop` stops normal services without deleting containers or the named
PostgreSQL volume. `-NoOpen` performs the complete start, readiness, catalog,
and stale-backup workflow but suppresses the final browser launch; it is useful
for unattended verification.

Docker Desktop must be running for imports and scheduled syncs. After sleep or
shutdown, the scheduler queues one catch-up run for each overdue Daily or
Weekly source.

## 4. Source synchronization

Each monitored channel has one of these policies:

- **Manual**: runs only through Sync now.
- **Daily**: the default; due 24 hours after the last successful run.
- **Weekly**: due seven days after the last successful run.

Initial history is explicitly bounded by Latest 10, Latest 25, Latest 50, Since
date, or All history. One-off video imports never enable monitoring for the
video's creator. Channel jobs are serialized so backfill, manual sync, and
scheduled polling cannot enumerate the same source concurrently.

Use Activity and Source review to inspect quota errors, terminal failures,
parser warnings, ignored links, and videos that produced no projects. Retry a
terminal item only after its underlying problem has been addressed.

## 5. Backups

```powershell
.\hardware.ps1 backup
.\hardware.ps1 install-backup-task
```

The backup service creates a PostgreSQL custom-format dump in an ephemeral
container, encrypts it with AES-256-CBC/PBKDF2 before it enters the host backup
directory, and writes a SHA-256 checksum. Plaintext is removed when the
container exits.

Retention keeps successful daily archives for seven days and the latest four
Sunday weekly restore points. The optional Windows task runs at 20:00 when
Docker Desktop is available. `start` creates a fresh backup whenever the newest
daily archive is older than 24 hours.

`BACKUP_RETENTION_DAYS` accepts `0` through `3650`, and
`BACKUP_RETENTION_WEEKS` accepts `0` through `520`. Values must be unquoted
base-10 integers without leading zeroes. Cleanup is limited to generated
archive names immediately inside the configured `daily` and `weekly`
directories; it does not recurse into owner-created subdirectories.

The named Docker volume is not a backup. Copy the encrypted backup directory to
an external disk or private synchronized folder if laptop loss must be covered.
Keep the encryption key separately; backups cannot be restored without it.

## 6. Restore drill

List the files under the `daily` or `weekly` child of the configured
`HARDWARE_BACKUP_DIR` (by default `backups/daily` or `backups/weekly`), then run:

```powershell
.\hardware.ps1 restore -RestoreFile hardware-YYYYMMDDTHHMMSSZ.dump.enc
```

The command requires typing `RESTORE`, stops web and worker, verifies the
checksum, decrypts inside the one-shot container, and restores into a temporary
database. Hardware retains the original database while it migrates and starts
the restored catalog. Only after a fresh worker heartbeat, readiness check, and
catalog read does it commit the switch; otherwise it reactivates the original.
The restore filename must be a basename; paths and traversal are rejected. A
successful owner restore records `local.restore_succeeded` in Activity. A
restore performed as part of failed-update recovery records the distinct
`local.update_rollback_succeeded` event before the final `local.update_failed`
summary, so recovery is not presented as an unrelated manual restore.

Test a backup after initial setup and after material schema changes.

## 7. Disposable runtime verification

To exercise the complete local lifecycle against disposable data, start Docker
Desktop and run:

```powershell
npm run verify:runtime
```

The verifier creates a GUID-scoped Compose project, random loopback port,
temporary environment file, temporary encryption key and backup directory, and
unique image tags. It proves runtime loopback publication, volume persistence
across PostgreSQL container replacement, encrypted backup/restore, and recovery
of the prior image and catalog after a deliberately failed candidate. It never
reads or overwrites `.env.local` and never uses the default `hardware` Compose
project or volume. Successful runs remove their isolated containers, volume,
images, and temporary files. Pass `-KeepArtifacts` directly to
`deploy\verify-local-runtime.ps1` only when retaining disposable evidence for
diagnosis is intentional.

## 8. Updates

```powershell
.\hardware.ps1 update
```

Update always creates a backup first. If a Git remote exists it performs a
fast-forward-only pull, builds the new Git-tagged image, runs migrations, starts
the replacement services, and records the new release. Updates are explicit;
there is no silent schema-changing auto-update.

The running image receives a dedicated rollback tag before writers stop. The
prior image and pre-update encrypted backup are retained. If a build, migration,
readiness, or catalog smoke check fails, the launcher restores the backup when
needed, retags the prior image, and restarts the last healthy catalog.

## 9. Troubleshooting

| Symptom | Check | Response |
| --- | --- | --- |
| Docker unavailable | Docker Desktop status | Start Docker Desktop, then rerun the command. |
| UI does not open | `.\hardware.ps1 status` and web health | Inspect the web container's safe structured logs. |
| Sync is overdue | Worker health and Activity | Start Docker and allow the overdue catch-up job to run once. |
| YouTube quota error | Latest source-review/job code | Wait for quota recovery; do not repeatedly retry. |
| Channel produced no projects | Source review and raw description | Open the original video/description and add a manual correction if appropriate. |
| Backup missing | Backup directory and scheduled task | Run `.\hardware.ps1 backup`; verify Docker and the key file. |
| Restore checksum failure | Matching `.sha256` and encryption key | Do not restore; recover an intact backup copy. |

Logs and audit summaries must never contain provider credentials, full notes,
raw fetched HTML, or complete descriptions. Safe errors and correlation IDs are
the intended diagnostic surface.
