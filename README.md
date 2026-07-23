# Hardware

Hardware is a personal, source-grounded desktop workspace for discovering and
organizing open-source projects mentioned in timestamped YouTube videos. It
runs on one computer, stores its catalog in local PostgreSQL, and never needs a
login screen. The supported interface is a desktop browser at `1024px` wide or
larger; this release does not provide a mobile or tablet UI.

Hardware stores metadata, descriptions, links, notes, and repository facts. It
does not download videos, request captions, clone repositories, or send catalog
content to an AI provider.

## Personal Local v1.1

- Desktop-browser workspace at `http://127.0.0.1:3000`.
- Persistent singleton local owner; no Clerk or public account system.
- Explicit one-off YouTube video imports that never subscribe to a channel.
- Monitored channels with Manual, Daily, or Weekly schedules and overdue
  catch-up after the worker restarts.
- Configurable initial channel history and independent, retryable video jobs.
- Single and bulk URL capture with preview, duplicate detection, partial
  success, and per-item status.
- Deterministic timestamp-block parsing with exact source provenance.
- Source review for warnings, ignored links, and videos with no projects.
- Searchable library, collections, notes, repository review, and audit history.
- Light, Dark, and System desktop themes.
- Local Docker lifecycle, encrypted backups, restore, and explicit updates.

AI, Instagram ingestion, media downloads, mobile UI, and public hosting are out
of scope for this release.

## Start Hardware on Windows

Requirements: Docker Desktop, PowerShell, Git for Windows (for updates), a
YouTube Data API key, and roughly a few gigabytes of free disk.

```powershell
.\hardware.ps1 setup
.\hardware.ps1 start
```

Setup creates `.env.local`, a random database password, a private probe token,
and a backup encryption key. These files are ignored by Git. Start builds the
local image when its configured tag is absent (otherwise it reuses that image),
migrates PostgreSQL, starts the web and worker processes, creates a backup when
one is stale, and opens the desktop workspace.

Useful commands:

```powershell
.\hardware.ps1 status
.\hardware.ps1 start -NoOpen
.\hardware.ps1 backup
.\hardware.ps1 restore -RestoreFile hardware-YYYYMMDDTHHMMSSZ.dump.enc
.\hardware.ps1 update
.\hardware.ps1 stop
.\hardware.ps1 install-backup-task
```

`start -NoOpen` performs the same startup, readiness, and stale-backup checks
without launching a browser. Backup folders, the key path, and bounded
retention can be changed in `.env.local`; see the operations guide before
relocating the encryption key.

Stopping containers does not delete the PostgreSQL volume. Never use
`docker compose down -v` unless permanent data deletion is explicitly intended.

## Runtime

Docker Compose runs four normal services:

1. PostgreSQL on a private Docker network.
2. A one-shot migration service.
3. The Next.js web app published only on `127.0.0.1`.
4. Graphile Worker for imports, syncs, refreshes, retries, and schedules.

Scheduled work operates only while Docker Desktop is running. When the worker
returns after sleep or shutdown, it queues one overdue run per monitored source
instead of replaying every missed interval.

## Development and verification

```powershell
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run test:bdd
npm run test:e2e
npm run db:check
npm run db:api-smoke
npm run db:mutation-smoke
npm run build
npm run security:audit
npm run verify:runtime
```

Both npm web commands bind explicitly to `127.0.0.1`; keep that loopback
binding because the personal application has no login boundary. The opt-in
runtime verifier uses only GUID-scoped disposable containers, volumes, images,
credentials, backups, and a random loopback port; it never uses `.env.local` or
the default Compose volume.

The full product contract is in [docs/SPEC.md](docs/SPEC.md). Local operation,
backup recovery, provider credentials, and troubleshooting are documented in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Security boundary

Every request reaching Hardware has owner-level access. The application must
remain bound to the loopback interface. Do not expose it through a LAN port,
public reverse proxy, VPS, or sharing tunnel without adding an authentication
boundary again. Same-origin mutation checks, SSRF controls, input limits, rate
limits, audit records, and protected readiness/metrics remain enabled locally.
