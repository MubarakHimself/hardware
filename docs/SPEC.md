# Hardware Personal Local v1.1 specification

Status: Accepted for implementation

Method: Specification-driven development with executable BDD scenarios
Last updated: 2026-07-22

## 1. Product outcome

Hardware Personal Local v1.1 is a single-person, desktop-only research catalog for open-source projects discovered in YouTube roundup descriptions and direct URLs. It runs on one computer, stores its catalog locally, requires no sign-in, and uses deterministic ingestion rather than AI.

V1.1 succeeds when the owner can:

1. Start Hardware locally and enter the complete application without a login or account screen.
2. Import one YouTube video without accidentally subscribing to its channel.
3. Add a YouTube channel explicitly, select how much history to import, and run it manually, daily, or weekly.
4. Preview a multiline batch, inspect detected types and duplicates, submit the ready rows, and retry failed rows without duplicating successful work.
5. Find a project from incomplete memory and trace it to the exact video, timestamp, raw description block, and original URL.
6. Review videos with parser warnings, unsupported links, or no discovered projects.
7. Use a polished desktop interface in Light, Dark, or System mode.
8. restart or update the local Docker installation without losing data, and create and restore encrypted local backups.

## 2. Fixed scope

### Included

- A persistent singleton local owner; no authentication, registration, invitation, account menu, roles, or remote users.
- A browser-based desktop interface served only on the loopback interface.
- Official YouTube Data API ingestion of video descriptions and channel upload metadata.
- Explicit one-off YouTube video imports and explicit monitored-channel subscriptions.
- Multiline import preview, per-row validation, partial success, retry, and idempotency.
- Manual, Daily, and Weekly monitored-channel schedules, with Daily as the default.
- Backfill choices of latest 10, 25, or 50 accessible uploads, uploads since a date, or all accessible history.
- Deterministic timestamp-block parsing and exact provenance retention.
- Direct website and public GitHub repository imports and deterministic metadata enrichment.
- Search, filters, card/list views, personal collections, notes, and an `Impressive` flag.
- Repository-candidate review, canonical edits, merge/split, refresh, job retry, audit history, and a source-review inbox inside Activity.
- Light, Dark, and System themes.
- Docker Desktop local runtime, persistent PostgreSQL storage, background jobs, local health checks, encrypted backups, restore, and update/rollback commands.

### Explicitly excluded

- AI summaries, LLM calls, embeddings, agents, repository chat, or NotebookLM-style synthesis.
- Transcripts, captions, audio extraction, frame extraction, video downloads, or media storage.
- Instagram, TikTok, or other social-video ingestion. An Instagram URL is reported as an unsupported provider and is never fetched.
- Repository cloning, code execution, package installation, or source-code analysis.
- Understand Anything, Repobase, Foglamp, NotebookLM, or MCP runtime integrations.
- Public hosting, Contabo deployment, Caddy, TLS certificates, public DNS, remote access, multi-user sharing, or mobile/tablet UI.
- CSV/file uploads. V1.1 bulk import is a paste-first, one-URL-per-line desktop workflow.

The schema retains stable project and repository identities so excluded analysis features can be added later without redefining catalog identity.

## 3. Local trust and owner model

Hardware has exactly one persistent owner with the stable UUID `00000000-0000-4000-8000-000000000001`.

- Startup idempotently creates the local owner if it does not exist.
- Every collection, note, preference, import, and owner-authored audit event references that owner.
- Every local UI capability is available to that owner, including sources, repository review, edits, merge/split, refresh, jobs, backups, and settings.
- The application has no login, logout, registration, invitation, profile, membership, role picker, Clerk provider, Clerk webhook, bearer token, or authentication cookie.
- Server code derives the owner from local configuration; it never accepts an actor or owner ID from a request.
- Existing demo-owner rows already using the stable UUID are preserved. During migration, other personal rows are reassigned to the stable owner, workspace-visible collections become personal collections, and name collisions receive a deterministic numeric suffix. No project, provenance, note, collection membership, or audit event is discarded.

Local-only is the security boundary:

- The web port defaults to `3000` and is published as `127.0.0.1:${HARDWARE_PORT:-3000}` only.
- The web server rejects requests whose effective local address is not loopback. Forwarded-host and forwarded-address headers are not trusted.
- PostgreSQL and the worker publish no host ports. They are reachable only on the private Compose network.
- Mutations require a same-origin request whose origin is the configured loopback application origin. There are no cross-origin API responses.
- Source credentials are read from the local environment and never returned by an API, written to a log, or stored in browser storage.
- The owner may intentionally use YouTube and GitHub over outbound HTTPS. "Local" does not mean offline; it means the application, database, jobs, settings, and backups remain on the owner's machine.

This boundary protects against accidental LAN or internet exposure. It does not claim to protect data from another person or process already controlling the computer.

## 4. Desktop-only experience

Hardware is a local web application designed and tested only for a desktop browser at viewports at least `1024 × 720` CSS pixels.

- The primary navigation is a persistent desktop sidebar. There is no mobile drawer or touch-first layout requirement.
- At a viewport narrower than 1024 pixels, Hardware shows a desktop-required notice instead of compressing the full workspace into a mobile layout.
- Keyboard navigation, visible focus, semantic labels, reduced-motion support, and WCAG 2.2 AA contrast apply in every theme.
- The principal surfaces are:
  - **Radar**: new discoveries and quick triage.
  - **Library**: canonical search, filters, card/list modes, and saved personal state.
  - **Sources**: monitored channels, one-off imports, bulk import, schedules, progress, and Sync Now.
  - **Collections**: personal project boards.
  - **Activity**: jobs, warnings, failures, retries, audit history, and the source-review inbox.
  - **Settings**: theme, local trust boundaries, recovery policy, and launcher commands.
  - **Project detail**: Overview, Sightings, Repository, and History.

Repository candidates remain a Radar workflow; parser/source exceptions live in Activity. V1.1 does not add a separate Review navigation destination.

Account avatars, user menus, `Admin` badges, invitation language, workspace-sharing language, and permission explanations are absent.

## 5. Theme contract

The theme preference is `light`, `dark`, or `system`; a new installation defaults to `system`.

- `system` follows the operating-system color-scheme setting and responds when it changes.
- The selected preference is saved in local browser storage. Theme preference contains no private source data and remains specific to that desktop browser profile.
- The pre-hydration script and hydrated application resolve the same effective theme.
- Light and Dark use semantic design tokens. Product surfaces may not depend on hard-coded light-only foregrounds, backgrounds, borders, or shadows.
- Charts, badges, dialogs, empty states, focus rings, native controls, and syntax-like provenance blocks remain readable in all three preferences.

## 6. Domain model and invariants

All application IDs are UUIDs except stable provider IDs. Timestamps are UTC `timestamptz`; schedule display uses the host's local time. User-entered text is length-limited plain text.

| Entity | Required contract |
| --- | --- |
| `users` | singleton local-owner ID, display label, created/updated time; no provider subject or personal profile is required |
| `channel_sources` | YouTube channel ID, uploads-playlist ID, canonical URL/name, explicit monitored flag, schedule, history policy, sync checkpoint, next sync, last attempt/success |
| `video_sources` | YouTube video ID, channel identity, title, published time, description, availability, ETag, last validation; a one-off video does not imply a monitored channel |
| `projects` | canonical/editorial fields, normalized primary URL, review state, repository ID, created/updated time |
| `project_aliases` | redirect/search aliases retained through merges |
| `project_links` | project, kind, exact original URL, normalized URL, source and verification state |
| `sightings` | project, channel/video, timestamp seconds/label, full raw timestamp block, original/normalized URL, parser version |
| `repositories` | provider, owner/name, canonical URL, default branch, head SHA, deterministic metadata and refresh time |
| `repository_candidates` | project, candidate identity, method/evidence/score, pending/approved/rejected state and decision |
| `collections` | local owner, title, description, optimistic version |
| `collection_projects` | collection/project membership, position and added time |
| `project_notes` | owner/project unique pair, plain-text note and optimistic version |
| `project_preferences` | owner/project unique pair and `is_impressive` flag |
| `import_batches` | idempotency key, requested owner, queued/duplicate/invalid counts, correlation ID, created/updated time |
| `import_batch_items` | batch/row, exact input, detected/selected kind, normalized identity, state, safe error, job ID |
| `source_reviews` | source/video, safe diagnostic evidence, open/resolved/ignored state, optimistic version/fingerprint, decision owner/note/time |
| `ingestion_jobs` | type/scope, idempotency key, state, progress, attempts, checkpoint, safe error and times |
| `audit_events` | local actor or system origin, action, target type/id, correlation ID, redacted before/after summary and timestamp |

Hard invariants:

- One canonical project has zero or more sightings; each sighting belongs to exactly one project.
- `(video_id, timestamp_seconds, normalized_url)` uniquely identifies a sighting.
- Original URLs and raw timestamp blocks are immutable until a YouTube retention rule requires their purge.
- A verified GitHub owner/name is the strongest project identity; a normalized canonical website URL is second. Similar names never auto-merge.
- Merge retains provenance, links, collections, preferences, notes, candidates, aliases, and audit history. Predecessor IDs resolve to the canonical project. Split moves explicitly selected evidence and records the mapping.
- A one-off import can record channel identity for provenance, but it never sets `monitored`, selects history, queues a channel backfill, or creates a future poll.
- At most one backfill or poll for the same monitored channel may be active. Job and import-item idempotency keys are enforced by the database, not only by the UI.

## 7. YouTube ingestion

### 7.1 Provider boundary

Hardware uses only the official YouTube Data API endpoints required to resolve channels, enumerate upload playlists, and fetch video metadata.

- It reads video titles, descriptions, publication time, duration, availability, ETag, and channel identity.
- Video metadata is fetched in batches of at most 50 IDs per API call.
- It does not scrape YouTube pages or request captions, transcripts, media streams, audio, frames, or downloads.
- It does not persist a video file or proxy playback.
- Every sighting has an **Open in YouTube** action using the canonical watch URL and `t=<timestamp_seconds>s`, so the owner can inspect the original video when necessary.
- Cached YouTube source data is revalidated at least every 30 days.

### 7.2 Description-first parser

- A timestamp block starts at `M:SS`, `MM:SS`, `H:MM:SS`, or `HH:MM:SS` at a line boundary and ends immediately before the next timestamp marker or the end of the description.
- A block yields at most one primary sighting: the first eligible external HTTP(S) project URL on any line in the complete block. Other eligible URLs in the same block are retained as project links.
- The stored raw segment is the complete timestamp block, not only the timestamp line and one continuation line.
- Decode a YouTube redirect only through an explicit `q` or `url` destination parameter.
- Ignore an intro block without a project URL. Exclude newsletter, sponsor, affiliate, subscription, social-profile, hashtag, and known self-promotional links.
- Parser warnings and ignored-link reasons are deterministic and safe to display.
- The saved `KITOm0HitpY` fixture remains the golden contract and yields exactly 20 sightings.

### 7.3 One-off video

Submitting a YouTube watch, `youtu.be`, or supported Shorts URL as `one_off` queues exactly that video.

- The video ID is normalized before an idempotency key is created.
- Repeated concurrent submissions resolve to the existing video/import job.
- The source channel may appear on provenance, but it is not monitored and no other upload is enumerated.
- Success, zero sightings, parser warnings, provider errors, and unsupported/private video states are visible per import item.

### 7.4 Monitored channel

Adding a channel is an explicit subscription action. Hardware resolves a channel URL, ID, or `@handle` to its official channel ID and uploads playlist.

The owner chooses one initial-history policy:

- `latest` with an allowed count of 10, 25, or 50; default `latest 25`.
- `since` with an inclusive local calendar date converted to a UTC boundary.
- `all`, meaning all accessible uploads returned by the official API.

Every accessible selected upload is queued independently. A channel parent remains active until its selected child video jobs are terminal and reports completed, total, warning, and failure counts.

Incremental sync walks newest uploads until the durable checkpoint is reached, then queues only previously unseen video IDs. A checkpoint advances only after its corresponding metadata is durably stored.

### 7.5 Schedules and catch-up

Each monitored channel has `manual`, `daily`, or `weekly`; the default is `daily`.

- Daily sets `next_sync_at` to 24 hours after the last completed automatic or manual sync.
- Weekly sets it to seven days after the last completed automatic or manual sync.
- Manual has no `next_sync_at` and never queues itself.
- **Sync Now** is available for every monitored channel and shares the same per-channel concurrency/idempotency guard as automatic sync.
- Changing from Manual to Daily or Weekly queues an immediate sync only when no successful sync exists or the calculated due time is already past.
- When the worker starts after sleep or shutdown, it queues at most one catch-up job for each overdue channel. Missed intervals are not replayed individually.
- If a job for that channel is queued or running, catch-up and Sync Now return that active job rather than creating another.
- After a terminal automatic failure, the failure remains visible and the next due time advances by the selected interval; the owner may retry immediately.

## 8. Single and bulk import

Sources provides **Single** and **Bulk** modes. Nothing is queued during preview.

### Multiline input

- One non-empty, non-comment line is one item. Lines beginning with `#` are comments.
- Leading/trailing whitespace is ignored while the exact entered value is retained for provenance and error reporting.
- Detection supports YouTube video, YouTube channel, public GitHub repository, and generic HTTP(S) website URLs.
- YouTube videos default to `one_off`. YouTube channels default to monitored, Daily, latest 25.

### Preview and submission

- Preview assigns a stable row number and shows exact input, normalized URL, detected kind, one-off/subscription behavior, schedule/history where applicable, duplicate state, and validation errors.
- Duplicates within the pasted batch are visible before submission. Existing sources or jobs are reported as duplicates by the durable submission step.
- The owner can edit the pasted lines, remove invalid rows, or submit the ready rows only.
- Submission is partial: valid rows each get an independent import item/job; invalid rows remain unqueued with a safe reason. The durable API also preserves invalid rows if an API client submits them.
- The batch response reports queued, duplicate, and invalid counts. Reading a batch joins each queued item to its current durable-job state.
- Idempotency identity is provider ID for YouTube video/channel, lowercased owner/name for GitHub, and normalized URL for a website.
- Re-previewing or re-submitting identical input does not duplicate a source, sighting, project, subscription, or active job. It returns the existing identity and reports `already imported`, `already monitored`, or `already queued`.
- Failed items can be retried independently; successful siblings are never rerun by that retry.
- Instagram and other unsupported social-video URLs remain invalid preview rows and cause no network request.

## 9. Source review inbox

Activity contains actionable source-review items, separate from repository candidates on Radar.

A deterministic, deduplicated review item is created when:

- a processed video produces zero project sightings;
- the parser records malformed timestamps, rejected or unsupported links, or ambiguous primary links;
- a parser diagnostic, rejected row, or ignored-link reason needs inspection.

One deduplicated row is retained per video. The paginated Activity contract exposes only the source identity, safe diagnostic counts, related-job summary, resolution metadata, optimistic version/fingerprint, and updated time; raw rejected rows, ignored links, and diagnostic messages never enter that response. The owner can inspect the video, add a resolution note, mark the row resolved, or ignore it. A decision records the singleton local owner, note, and resolution time. The issue fingerprint and version reject a stale decision, prevent an unchanged ignored result from reopening, reopen a changed result, and allow a clean reprocess to resolve it. Resolving or ignoring a review item never alters immutable provenance. If a provider reports that a video is unavailable, raw review evidence is purged with the restricted source payload while the safe review summary remains auditable.

## 10. URL normalization, repository resolution, and safe metadata

- Preserve the exact original URL separately from the normalized matching URL.
- For matching, unwrap supported YouTube redirects; allow HTTP(S) only; lowercase host; remove default port and fragment; normalize empty path; remove a trailing root slash; remove only allowlisted trackers (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref`); and sort remaining query parameters.
- Parser normalization never follows redirects.
- Auto-attach exact public GitHub repository URLs. Auto-attach a website-discovered repository only when exactly one unambiguous public GitHub repository link exists. Search-based matches remain pending candidates.
- A rejected candidate is not re-proposed unless its normalized identity or evidence hash changes.
- Website metadata fetches only HTTP(S), resolves DNS before every connection and redirect, and blocks loopback, private, link-local, carrier-grade NAT, multicast, and metadata-service ranges for IPv4 and IPv6.
- Allow at most three redirects, 2 MB decompressed HTML, a ten-second total timeout, and HTML content types. Parse only title, description, icon/OG image URL, canonical URL, and anchors; never execute scripts.

## 11. Search and personal organization

PostgreSQL full-text search and trigram matching cover project names, descriptions, aliases, URLs, repository identity/topics/language/license, source titles, collection names, and the owner's notes. Ranking is exact identifier/URL, prefix, full-text relevance, then trigram similarity.

Supported URL-backed query state is `q`, `channel`, `repository`, `language`, `license`, `activity`, `collection`, `impressive`, `sort`, `view`, and cursor. It survives card/list changes and detail back-navigation. Results are cursor-paginated and capped at 100 rows per request.

All collections are personal. A project can belong to multiple collections. The owner has one note and one `Impressive` preference per project. Optimistic versions prevent stale overwrites. There is no visibility selector or sharing state.

## 12. HTTP and durable-job interfaces

JSON endpoints return `{ data, meta? }` or RFC 9457 problem details. No application endpoint accepts a user ID, role, provider subject, bearer token, or session token. Mutations validate with Zod, enforce loopback and same-origin boundaries, and emit a correlation ID.

| Method and path | Behavior |
| --- | --- |
| `GET /api/projects` | Cursor search and filters |
| `GET /api/projects/:id` | Project, personal state, repository, and provenance |
| `PATCH /api/projects/:id` | Version-checked canonical fields |
| `POST /api/imports` | Queue one direct YouTube video/channel, website, or GitHub repository import; channel imports enter the durable monitored-channel handoff |
| `POST /api/import-batches/preview` | Validate up to 500 structured rows without queueing |
| `POST /api/import-batches` | Queue valid batch rows with item-level duplicate and validation results |
| `GET /api/import-batches/:id` | Batch counts plus each item's current durable-job state |
| `POST /api/import-batches/:id/items/:itemId/retry` | Retry one item whose job failed |
| `GET/POST /api/collections` | List/create personal collection |
| `PATCH/DELETE /api/collections/:id` | Version-checked update/delete |
| `PUT/DELETE /api/collections/:id/projects/:projectId` | Idempotent membership |
| `PUT /api/projects/:id/note` | Upsert the owner's note |
| `PUT /api/projects/:id/preference` | Upsert the owner's preference |
| `GET/POST /api/channels` | List/add explicit monitored channel |
| `PATCH /api/channels/:id` | Pause/resume, schedule, and history defaults |
| `POST /api/channels/:id/sync` | Sync Now, returning an existing active job if present |
| `GET /api/source-reviews` | Cursor-page safe review summaries by state, with true total/open counts |
| `PATCH /api/source-reviews/:id` | Resolve, ignore, or reopen one review row with expected fingerprint/version |
| `GET/POST /api/repository-candidates` | List and decide repository candidates |
| `POST /api/projects/:id/merge` | Merge into canonical target |
| `POST /api/projects/:id/split` | Move selected sightings/links |
| `GET /api/jobs` | All local jobs with safe failures |
| `POST /api/jobs/:id/retry` | Retry one terminal failed job/item |
| `GET /api/audit-events` | Cursor-page safe local operation and catalog history with a true total |
| `GET /api/health/live` | Loopback process liveness |
| `GET /api/health/ready` | Loopback database and worker readiness |
| `GET /api/metrics` | Loopback Prometheus exposition |

Graphile Worker tasks are `channel_resolve`, `channel_backfill`, `channel_poll`, `video_ingest`, `youtube_revalidate`, `website_metadata`, `repository_resolve`, and `repository_refresh`. `channel_resolve` durably resolves a pasted channel identity, creates or reuses its monitored source, and hands the same batch item to the initial backfill. Provider operations default to three attempts with exponential backoff. Terminal failures remain visible and retryable.

## 13. Local Docker, persistence, backup, and update

The supported runtime is Docker Desktop with Compose services `web`, `worker`, and `postgres`.

- `web` is the only published service and binds to loopback.
- `postgres` stores data in a named volume. Container replacement, restart, and ordinary image updates do not remove the volume.
- `worker` uses the private Compose network and publishes no port.
- Health checks validate web liveness, database readiness, and worker freshness.
- The image runs as a non-root user with a read-only application filesystem except explicit temporary paths.
- `hardware start`, `stop`, `status`, `backup`, `restore`, and `update` PowerShell commands are the supported owner interface. They may be implemented as documented scripts rather than a globally installed executable.

Backups:

- `hardware backup` creates a PostgreSQL custom-format dump, encrypts it before it enters the configured visible backup directory, writes a SHA-256 manifest, and verifies the archive can be listed.
- No plaintext database dump remains after success or failure.
- Backups default to the visible `./backups` folder beside the project files. Successful daily archives remain for seven days, and the latest four Sunday archives remain as weekly restore points unless configured otherwise.
- `hardware restore <archive>` verifies checksum and encryption, stops web/worker writes, and restores into a temporary database. It stages that database under the canonical name while retaining the original, runs current migrations plus fresh-worker readiness and catalog checks, then either drops the retained original or reactivates it through the crash-recoverable startup reconciliation protocol. Failed verification never changes the current database; failed staging never discards it.

Updates:

- `hardware update` refuses to start with unhealthy current services.
- It creates and verifies a mandatory pre-update backup, records the current image and schema versions, obtains/builds the new image, runs migrations as a separate one-shot service, and starts the new services.
- The update succeeds only after readiness and a catalog read smoke test.
- On failure it restores the prior image; if a migration changed persistent state, it restores the verified pre-update backup before restarting the prior image.
- Update and restore events appear in Activity without secrets.

Removing Hardware containers does not remove its data or backups. Deleting the database volume or backup archives requires a separate explicit command and confirmation; normal stop/update scripts never use `down -v`.

## 14. Quality and release gates

Required before Personal Local v1.1 is complete:

1. Every scenario under `features/` passes.
2. Strict TypeScript, ESLint, unit, integration, migration, and production build gates pass.
3. A fresh Docker installation starts without Clerk or public-host configuration and creates exactly one local owner.
4. Network inspection proves only the selected loopback web port is published; a LAN-address request fails.
5. A one-off video queues exactly one video and leaves its channel unmonitored.
6. Channel backfill options, Manual/Daily/Weekly scheduling, overdue catch-up, and per-channel overlap protection pass with a controlled clock.
7. Multiline imports prove preview-without-side-effects, partial success, item retry, and database-backed idempotency.
8. Golden-description parsing proves complete-block retention and 20 sightings without caption/media calls.
9. Source-review creation, deduplication, resolution, ignore, and recurrence pass.
10. Light, Dark, and System modes pass desktop keyboard, contrast, no-flash, and axe checks at 1024×720, 1280×800, and 1440×900.
11. Restart/container-replacement persistence, encrypted backup, clean restore, failed-restore isolation, pre-update backup, and rollback are exercised with disposable data.
12. Secret scan and production-dependency audit pass.
13. Documentation contains the exact local start/stop/status/backup/restore/update commands and clearly states the outbound YouTube/GitHub dependency.

No public deployment, mobile acceptance test, Clerk credential, AI provider, Instagram credential, transcript service, or media storage is a release prerequisite.
