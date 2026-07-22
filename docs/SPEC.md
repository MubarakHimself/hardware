# Hardware v1 product and engineering specification

Status: Accepted for implementation
Method: Specification-driven development with executable BDD scenarios
Last updated: 2026-07-22

## 1. Outcome

Hardware is an invite-only intelligence catalog for open-source projects found in timestamped YouTube video descriptions. It continuously ingests configured channels, preserves exact source provenance, deduplicates projects conservatively, and lets members search, inspect, and organize the catalog.

V1 is successful when an invited user can:

1. Discover projects from a monitored channel or a one-off video, website, or public GitHub URL.
2. Find a project from incomplete memory through search and filters.
3. Trace a project to its exact channel, video, timestamp, raw description block, and original URL.
4. Put one project in several private or workspace-shared collections and keep private notes.
5. Review ingestion health and, as an administrator, approve ambiguous repository matches or retry failed work.

## 2. Fixed scope

### Included

- Official YouTube Data API channel backfill, six-hour incremental polling, and one-off video imports.
- Deterministic timestamp/link parsing from video descriptions.
- One shared, deduplicated project inventory with many source sightings.
- One-off website and public GitHub repository imports.
- Deterministic website and GitHub metadata.
- Search, filters, card/list views, collections, notes, and a personal `Impressive` flag.
- Admin repository-candidate review, merge/split, refresh, retry, and audit workflows.
- Invite-only Clerk authentication, PostgreSQL persistence, durable jobs, Contabo deployment, backups, health checks, structured logs, accessibility, and browser-tested journeys.

### Excluded from v1

- Transcripts, captions, embeddings, LLM calls, AI summaries, AI agents, or agent chat.
- Repository cloning, code execution, package installation, or code analysis.
- Runtime integration with Understand Anything, Repobase, Foglamp, NotebookLM, or MCP.
- Private repositories, non-GitHub repository providers, anonymous browsing, feeds, scoring, streaks, or other gamification.

The schema keeps stable repository IDs and commit metadata so later code-analysis and agent systems can be added without changing project identity.

## 3. Users and authorization

Hardware v1 has one shared alpha workspace.

- Clerk provides authentication and invitation management. Every product page and data endpoint is protected in production.
- A `member` can browse/search, manage their collections/notes/preferences, and submit supported one-off imports.
- An `admin` can additionally manage channels, approve or reject repository candidates, edit canonical display data, merge/split projects, refresh metadata, and retry jobs.
- Project records and sightings are workspace-shared.
- Collections are private by default. An owner may expose a collection read-only to the workspace; only its owner may modify it.
- Notes and `Impressive` preferences always remain private to their owner.
- Authorization is enforced at the server boundary. UI visibility is never an authorization control.
- All globally consequential changes append an immutable audit event.

Development may use an explicit `DEMO_MODE=true` fixture identity and fixture repository. Production startup fails closed when Clerk, database, the canonical HTTPS application origin, or source credentials required by the enabled processes are missing.

## 4. Product surface

- **Radar** shows newly discovered sightings, unresolved repository candidates, and source warnings.
- **Inventory** is the canonical project search surface with card/list modes, URL-backed search, sorting, and filters.
- **Collections** shows private and workspace-visible boards; a project may belong to many boards.
- **Channels** shows monitored sources, video totals, last sync, job progress, warnings, failures, and admin controls.
- **Project detail** has Overview, Sightings, Repository, and History sections.

Cards and rows show a deterministic title and description, source/repository status, GitHub topics/language/license/activity, latest source and timestamp, independent sighting count, collection state, and personal `Impressive` state. Project edits never overwrite raw source fields.

## 5. Domain contract

All IDs are UUIDs except stable provider IDs. Timestamps are UTC `timestamptz`. User-generated text is length-limited and stored as plain text.

| Entity | Required contract |
| --- | --- |
| `users` | Clerk subject, role (`member`/`admin`), display metadata, created/updated time |
| `channel_sources` | YouTube channel ID, uploads-playlist ID, canonical URL/name, enabled flag, sync state and checkpoint |
| `video_sources` | YouTube video ID, channel, title, published time, current description, availability, ETag, last validation |
| `projects` | canonical/editorial fields, normalized primary URL, review state, repository ID, created/updated time |
| `project_aliases` | redirect/search aliases retained through merges |
| `project_links` | project, kind, original URL, normalized URL, source and verification status |
| `sightings` | project, channel/video, timestamp seconds/label, raw segment, original/normalized URL, parser version |
| `repositories` | provider, owner/name, canonical URL, default branch, head SHA, deterministic metadata and refresh time |
| `repository_candidates` | project, candidate identity, method/evidence/score, pending/approved/rejected state and reviewer |
| `collections` | owner, title, description, private/workspace visibility and optimistic version |
| `collection_projects` | collection/project membership, position and added time |
| `project_notes` | owner/project unique pair, private plain-text note and optimistic version |
| `project_preferences` | owner/project unique pair and personal `is_impressive` flag |
| `ingestion_jobs` | type/scope, unique idempotency key, state, progress, attempts, checkpoint, safe error summary and times |
| `audit_events` | actor, action, target type/id, correlation ID, redacted before/after summary and timestamp |

Hard invariants:

- One canonical project has zero or more sightings; every sighting belongs to exactly one project.
- `(video_id, timestamp_seconds, normalized_url)` uniquely identifies an ingested sighting.
- Original source URLs and raw segments are immutable until source-retention policy requires their purge.
- A verified GitHub owner/name is the strongest project identity; normalized canonical website URL is second.
- Similar names never auto-merge.
- Merge retains provenance, links, collection memberships, preferences, notes, repository candidates, aliases, and audit history; predecessor IDs/slugs resolve to the canonical project and its detail history includes immutable predecessor events. Split moves explicitly selected provenance and records the mapping.

## 6. Ingestion contract

### YouTube

- Use only the official YouTube Data API. Do not scrape UI pages or request captions.
- Adding a channel resolves its canonical channel ID and uploads playlist before queuing accessible historical videos.
- Process and retry each video independently. All jobs are idempotent and checkpointed.
- A timestamp block starts at `M:SS`, `MM:SS`, `H:MM:SS`, or `HH:MM:SS` at a line boundary and ends immediately before the next timestamp marker.
- A block yields at most one primary project sighting: the first eligible external HTTP(S) URL on the timestamp line or a following line in that block. Additional eligible links are retained as project links.
- Decode YouTube redirect URLs only through an explicit `q` or `url` destination parameter.
- Ignore an intro block without an external project URL. Exclude newsletter, sponsor, affiliate, social-profile, subscription, and hashtag links outside project timestamp blocks.
- The saved `KITOm0HitpY` fixture is the golden contract and yields exactly 20 sightings.
- Revalidate cached YouTube API data at least every 30 days. When a video becomes unavailable, purge policy-restricted YouTube title, description, and raw segment data; retain non-YouTube project data, availability state, and a minimal audit record.

### URL normalization and deduplication

- Preserve the exact original URL separately from the normalized matching URL.
- For matching: unwrap supported YouTube redirects; allow only HTTP(S); lowercase host; remove default port and fragment; normalize an empty path to `/`; remove a trailing root slash; remove only allowlisted trackers (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref`); sort remaining query parameters.
- Do not follow redirects during parser normalization.
- Auto-attach exact public GitHub repository URLs. Auto-attach a website-discovered repository only when one unambiguous public GitHub repository link exists. GitHub search results are pending candidates and require admin approval.
- A rejected repository candidate is not re-proposed unless its normalized identity or evidence hash changes.

### Safe website metadata

- Fetch only HTTP(S), resolve DNS before every connection and redirect, and block loopback, private, link-local, carrier-grade NAT, multicast, and metadata-service ranges for IPv4 and IPv6.
- Allow at most three redirects, 2 MB decompressed HTML, a ten-second total timeout, and `text/html` or `application/xhtml+xml` content.
- Parse only title, meta description, icon/OG image URL, canonical URL, and anchors. Sanitize text and never execute scripts.

## 7. Search contract

PostgreSQL full-text search and `pg_trgm` cover project names/descriptions/aliases/URLs, repository owner/name/topics/language/license, source titles, visible collection names, and only the current user’s notes. Ranking is exact identifier or URL, prefix, full-text relevance, then trigram similarity.

Supported query state:

- `q`, `channel`, `repository`, `language`, `license`, `activity`, `collection`, `impressive`, `sort`, `view`, and cursor.
- Search/filter state is encoded in the URL and survives card/list switching and project-detail back navigation.
- Results are cursor-paginated and capped at 100 rows per request.

Target: representative 50,000-project search p95 below 500 ms on the production VPS.

## 8. HTTP and job interfaces

JSON endpoints return `{ data, meta? }` on success and RFC 9457 problem details on failure. The protected metrics endpoint is the sole text-format exception and emits Prometheus `0.0.4` exposition. Every mutation validates input with Zod, checks server-side role/ownership, applies rate limits, and emits a correlation ID. Mutations use same-site cookies plus origin verification; Clerk bearer tokens are accepted only on explicitly documented API routes.

| Method and path | Role | Behavior |
| --- | --- | --- |
| `GET /api/projects` | member | Cursor search and filters |
| `GET /api/projects/:id` | member | Project, visible personal state, repository and provenance |
| `PATCH /api/projects/:id` | admin | Version-checked canonical editorial fields |
| `POST /api/imports` | member | Queue `youtube_video`, `website`, or `github_repository` import |
| `GET/POST /api/collections` | member | List visible/create private collection |
| `PATCH/DELETE /api/collections/:id` | owner | Version-checked update/delete |
| `PUT/DELETE /api/collections/:id/projects/:projectId` | owner | Idempotent membership mutation |
| `PUT /api/projects/:id/note` | member | Upsert current user’s private note |
| `PUT /api/projects/:id/preference` | member | Upsert current user’s preference |
| `GET/POST /api/channels` | admin | List/add monitored channel |
| `POST /api/channels/:id/sync` | admin | Queue idempotent sync |
| `POST /api/jobs/:id/retry` | admin | Retry a terminal failed job |
| `GET /api/repository-candidates` | admin | List pending candidates and deterministic evidence |
| `POST /api/repository-candidates/:id/decision` | admin | Approve/reject with reason |
| `POST /api/projects/:id/merge` | admin | Merge into canonical target |
| `POST /api/projects/:id/split` | admin | Move selected sightings/links |
| `POST /api/webhooks/clerk` | signed Clerk webhook | Verify the signature, synchronize user lifecycle/role state, and retain no payload PII in audit summaries |
| `GET /api/health/live` | public | Process liveness only |
| `GET /api/health/ready` | private/probe | Database and worker freshness readiness |
| `GET /api/metrics` | private/probe | Prometheus queue, job, provider, worker, channel, and search telemetry |

Graphile Worker queues: `channel_backfill`, `channel_poll`, `video_ingest`, `youtube_revalidate`, `website_metadata`, `repository_resolve`, and `repository_refresh`. Default retry policy is three attempts with exponential backoff; terminal failures remain visible and manually retryable. Schedules are six hours for channels, seven days for repositories, and no more than 30 days for YouTube revalidation.

Channel progress remains active until every child `video_ingest` job tied to the latest channel parent is terminal. Child warnings, failures, and the latest retryable failed-child ID are included in the channel DTO even after the parent enqueue job succeeds.

Approving a repository candidate atomically attaches the stable repository identity, records a verified repository project link, and queues one idempotent immediate `repository_refresh` job whose durable checkpoint contains only `repositoryId`.

## 9. Production constraints

- Next.js App Router, strict TypeScript, React, Tailwind CSS, and shadcn-style repo-owned components built on Base UI primitives.
- Clerk for identity; Drizzle/PostgreSQL for persistence; Graphile Worker for durable background work.
- Docker Compose services for Caddy, web, worker, and PostgreSQL on Contabo. Migrations run as a separate, backward-compatible deployment step.
- CSP, HSTS in production, frame denial, MIME sniff protection, strict referrer policy, explicit permissions policy, and secure same-site cookies.
- Structured JSON logs contain correlation/job IDs but no tokens, secrets, full descriptions, notes, or raw HTML. Metrics include queue depth, job duration/failure, quota errors, search latency, fetch blocks/failures, and last successful channel sync.
- PostgreSQL receives a nightly encrypted logical backup with seven daily and four weekly restore points plus an off-host copy. Restore is documented and rehearsed before launch.
- Web, worker, and database expose independent health checks and graceful shutdown. Deployment retains the immediately previous image for rollback.
- Primary journeys meet WCAG 2.2 AA keyboard/focus expectations and contain no serious automated accessibility violations.

## 10. Verification and traceability

- Feature files in `features/` are the human-readable acceptance source.
- Vitest unit tests cover parser, URL normalization, authorization policies, validators, ranking helpers, and deterministic ingestion-store idempotency contracts.
- Real-PostgreSQL integration tests execute schema invariants, catalog reads, repository decisions, collection ownership, merge/split, source-retention purge, and job retry transitions through the production server functions.
- Browser journeys cover authentication boundary, inventory search/filter/view state, project provenance, multi-collection membership, channel progress, repository approval, import validation, keyboard navigation, responsive layout, and visible error/recovery states.
- CI gates on type-check, lint, unit/integration tests, production build, migration drift, dependency audit policy, and browser acceptance tests.

## 11. Locked defaults

- Product name: Hardware.
- Launch: invite-only private alpha, one shared workspace.
- Accounts: Clerk Hobby initially; `member` and `admin` roles.
- Database: PostgreSQL on the existing Contabo VPS; no Neon or Supabase dependency.
- Personal state: private by default; selected collections may be shared read-only with the workspace.
- Deployment: Docker Compose and Caddy; OpenShip is evaluated only after launch.
- V1 is deterministic and contains no AI.
