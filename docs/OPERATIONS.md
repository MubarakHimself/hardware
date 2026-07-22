# Hardware operations runbook

Hardware v1 is a single-node production deployment on the existing Contabo VPS. Docker Compose runs Caddy, the Next.js web process, the Graphile Worker process, and PostgreSQL. The design minimizes paid infrastructure, but the VPS remains a single failure domain; the encrypted off-host database copy is therefore a launch requirement.

## 1. Host baseline

Provision a supported 64-bit Debian or Ubuntu LTS host with at least 4 GB RAM, current Docker Engine with the Compose plugin, Bash, OpenSSL, Git, curl, restic, and enough disk for two application images plus database growth and local backup retention.

1. Point the application domain's A/AAAA records at the VPS.
2. Permit inbound SSH, TCP 80, TCP 443, and UDP 443 in the host and provider firewalls. Do not expose PostgreSQL port 5432.
3. Create `/opt/hardware` as the Git checkout and `/var/backups/hardware` as a root-only backup directory.
4. Keep Docker and the host security packages patched. Disable password-based SSH and root SSH login after key access is proven.
5. Copy `.env.example` to `/opt/hardware/.env.production`, fill every required value, then set mode `0600` and root ownership. Never commit this file. Keep values shell-safe; percent-encode the database password inside `DATABASE_URL` while retaining the raw value in `POSTGRES_PASSWORD`.

Generate a unique `HEALTHCHECK_TOKEN` with at least 32 characters (for example, `openssl rand -base64 48`). Readiness and metrics accept it only as an `Authorization: Bearer …` credential; never place it in a query parameter or a custom header.

The production Compose network exposes only Caddy. PostgreSQL, Next.js, and the job worker remain on the private bridge network.

## 2. External configuration

### Clerk

Use separate Clerk development and production instances. Enable invitation-only sign-up in the Clerk dashboard, add the production application origin, and register the application's webhook endpoint for user create/update/delete lifecycle events. Put at least one Clerk user ID in `ADMIN_CLERK_USER_IDS`; server-side authorization remains authoritative.

The Docker build needs only `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. `CLERK_SECRET_KEY` and the webhook signing secret are runtime-only values.

### YouTube and GitHub

Restrict the YouTube Data API key to the required API and the production server where provider controls support it. Set a GitHub token when repository refresh volume would exceed anonymous API limits. Neither secret may appear in browser bundles or logs.

### Off-host backups

Initialize an encrypted restic repository in storage outside the VPS, then set `RESTIC_REPOSITORY` and `RESTIC_PASSWORD`. A same-disk dump protects against application mistakes but not disk or VPS loss and is not an acceptable production backup by itself.

## 3. First deployment

From `/opt/hardware`:

```sh
chmod 700 deploy/*.sh
ENV_FILE=/opt/hardware/.env.production deploy/deploy.sh
```

The deployment script builds one image tagged with the Git commit, starts PostgreSQL, applies Drizzle and Graphile Worker migrations in a one-shot container, starts web/worker/Caddy, waits for private database/worker readiness, and then verifies public HTTPS liveness. The previously running image is retained as `hardware:rollback`.

After the first deployment, verify:

- HTTPS is valid and HTTP redirects to HTTPS.
- An anonymous request is sent to Clerk sign-in and cannot access product data.
- The invited admin can sign in and reach every primary navigation surface.
- `/api/health/live` returns success without revealing infrastructure details.
- Authenticated readiness reports PostgreSQL and a worker heartbeat.
- A fixture import completes and is idempotent when retried.
- Caddy, web, and worker logs contain correlation IDs and no credentials or raw source descriptions.

## 4. Routine release procedure

Every release must pass lint, type-check, unit/integration tests, executable BDD scenarios, the production build, and browser journeys before it reaches the VPS.

1. Pull the reviewed commit into `/opt/hardware`.
2. Confirm migrations are backward-compatible with both the current and new application image. Use expand/contract changes for destructive schema evolution.
3. Run `deploy/deploy.sh`.
4. Check `docker compose --env-file .env.production ps` and recent structured logs.
5. Exercise sign-in, inventory search, a project provenance page, collections, and the admin queue.

Do not automatically reverse database migrations during application rollback. If a new image is unhealthy and its migration was backward-compatible, run `deploy/rollback.sh`. Investigate and issue a forward repair migration when database state must change.

## 5. Health and observability

- Liveness answers only whether the Next process can serve requests.
- Readiness checks PostgreSQL and requires a worker heartbeat newer than 45 seconds. It requires the configured probe token as an `Authorization: Bearer …` credential.
- The worker writes a heartbeat every 15 seconds and removes it on graceful shutdown.
- Docker restarts failed services, while Graphile Worker supplies durable retries and exponential backoff.
- Domain-owned `ingestion_jobs` and `ingestion_events` expose safe progress and terminal errors without exposing Graphile internals.
- Caddy access logs remove all query strings and referrers and mask client IPs; search terms and Clerk callback parameters must never enter access logs.
- `GET /api/metrics` emits Prometheus text only after a constant-time check of the same `HEALTHCHECK_TOKEN` accepted by readiness. It never includes source titles, URLs, search terms, user identifiers, or error messages as labels.
- Database-derived metrics cover queue depth, completed duration and failures, safe quota/fetch codes, worker heartbeat age, and each enabled channel's last successful sync. Search latency is a process-local histogram and resets when the web process restarts.

Operational checks:

```sh
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --since 30m web worker caddy
docker compose --env-file .env.production exec postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Alert on public liveness failure, readiness failure, disk utilization above 80%, missing backups, PostgreSQL restart, worker heartbeat age above 60 seconds, growing queue depth, three-attempt job failures, quota errors, and a channel with no successful sync for more than 12 hours. An external free uptime probe is useful because an on-host monitor cannot report total VPS failure.

### Prometheus scrape configuration

Keep the probe token in a root/Prometheus-readable file outside the Git checkout, for example `/etc/prometheus/secrets/hardware-metrics.token` with mode `0400`. Configure the scrape over public HTTPS; do not put the token in the URL or a query parameter:

```yaml
scrape_configs:
  - job_name: hardware
    scheme: https
    metrics_path: /api/metrics
    static_configs:
      - targets: [hardware.example.com]
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/hardware-metrics.token
```

Load [`deploy/prometheus-alerts.yml`](../deploy/prometheus-alerts.yml) into the Prometheus `rule_files` list and validate it with `promtool check rules deploy/prometheus-alerts.yml` before reload. Keep external HTTPS liveness and host disk/PostgreSQL restart alerts alongside these application rules; the application endpoint cannot detect total host loss.

### Metrics and alert response

| Alert | First checks | Safe first action |
| --- | --- | --- |
| Metrics missing / worker stale | Read readiness, Compose service state, worker logs, newest `worker_heartbeats.last_seen_at` | Restart only the failed worker after preserving correlation IDs and its last logs. |
| Queue backlog / repeated failures | Group metrics by task/error code, inspect matching safe `ingestion_events`, confirm PostgreSQL health | Pause the affected schedule or source; do not repeatedly retry quota failures. |
| Provider quota limited | Confirm the provider and recent request volume without printing credentials | Pause provider-backed schedules until the quota window recovers. |
| Website fetch failures | Separate policy blocks from DNS/timeouts/HTTP errors using the safe code label | Pause website metadata tasks if failures suggest an SSRF regression. |
| Channel sync stale | Inspect the channel's latest safe job/event and next-sync time | Retry once only after resolving its terminal or provider cause. |
| Search latency high | Compare queue/DB pressure, PostgreSQL slow queries, and representative search plans | Preserve evidence, then tune the query/index; do not add an unmeasured search service. |

## 6. Backup, retention, and restore

Create a dedicated encryption key before enabling the timer. This key is not stored in the database, backup directory, Git, or restic repository and is required for every restore:

```sh
install -d -o root -g root -m 0700 /root/.config/hardware
openssl rand -base64 48 > /root/.config/hardware/backup-encryption.key
chown root:root /root/.config/hardware/backup-encryption.key
chmod 0400 /root/.config/hardware/backup-encryption.key
```

Record `BACKUP_ENCRYPTION_KEY_FILE=/root/.config/hardware/backup-encryption.key` in `.env.production`. Store a separate recovery copy of the key in the organization's secrets manager or offline vault; a database archive is permanently unrecoverable without it. Retain prior keys until every backup encrypted with them has expired.

Install the provided systemd unit and timer:

```sh
install -m 0644 deploy/hardware-backup.service /etc/systemd/system/
install -m 0644 deploy/hardware-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hardware-backup.timer
systemctl list-timers hardware-backup.timer
```

The backup script streams PostgreSQL custom-format output directly through OpenSSL AES-256-CBC with a random salt and PBKDF2-HMAC-SHA-256 (600,000 iterations) into a mode-`0600` temporary ciphertext, validates the decrypted archive through `pg_restore --list`, and only then atomically persists a `.dump.enc` file and SHA-256 manifest. No plaintext dump file is created. It keeps seven daily and four weekly encrypted local restore points, sends the encrypted daily artifact to the independently encrypted restic repository, and prunes both policies. The script fails before dumping if the encryption key, restic configuration, or required executable is unavailable.

After the first run and after every operational change, check `systemctl status hardware-backup.service`, inspect the newest `.dump.enc` plus adjacent manifest, and confirm the off-host snapshot with `restic snapshots --tag hardware-postgres`. Alert when the service fails or the newest successful artifact is older than 26 hours.

Test restoration before launch and quarterly thereafter on an isolated database/VPS. For an authorized in-place disaster restore:

```sh
CONFIRM_RESTORE=hardware \
  ENV_FILE=/opt/hardware/.env.production \
  deploy/restore.sh /var/backups/hardware/daily/hardware-YYYY-MM-DD.dump.enc
```

Restore requires the adjacent `.sha256` manifest, verifies the encrypted artifact, and decrypts it only as a pipe into `pg_restore`. A full archive-list preflight with the configured key completes before downtime. The actual clean restore runs in one database transaction; if restore or forward migration fails, web and worker remain stopped for investigation. On success it reapplies forward migrations and restarts application processes. Verify row counts, user ownership, source provenance, collection state, job history, readiness, metrics, and the primary browser journeys before declaring recovery complete.

## 7. Incident handling

1. Preserve the release SHA, correlation/job IDs, timestamps, and relevant redacted structured logs.
2. Stop only the affected mutation path when possible; read-only access may remain available.
3. Never paste environment files, Clerk tokens, API keys, notes, raw descriptions, or fetched HTML into tickets or chat.
4. For a compromised credential, rotate it at the provider, update `.env.production`, recreate affected containers, and inspect audit/job history.
5. For suspected SSRF, stop website-metadata workers, preserve the safe event record, and verify that no private-address connection was made.
6. For provider quota exhaustion, pause the relevant schedule rather than repeatedly retrying.

## 8. Capacity and maintenance

Start Graphile Worker at concurrency four, then tune using CPU, memory, provider quotas, PostgreSQL connections, and observed task duration. Keep total web and worker pool limits below PostgreSQL's reserved connection capacity. Run `VACUUM (ANALYZE)` through normal autovacuum; investigate table/index bloat before scheduling manual maintenance.

Before significant channel backfills, check YouTube quota and database disk headroom. Search performance must be measured against representative data; maintain the `pg_trgm` and full-text indexes and inspect slow queries rather than adding a second search service in v1.

OpenShip may later operate these same containers, but v1 deployment and recovery must remain valid with standard Docker Compose alone.
