# Hardware

Hardware is a private, source-grounded catalog of noteworthy open-source
projects discovered in timestamped YouTube videos. It turns channel uploads and
manual links into a searchable inventory with provenance, repository metadata,
collections, private notes, review queues, and durable ingestion history.

V1 deliberately does **not** clone repositories, ingest transcripts, generate
embeddings, or provide AI chat. Those capabilities can be evaluated later from
the clean catalog and provenance model; they are not hidden inside the first
release.

## Stack

- Next.js 16, React 19, TypeScript, Tailwind CSS, Base UI, and Clerk
- PostgreSQL 17 with Drizzle migrations, full-text search, and `pg_trgm`
- Graphile Worker for backfills, polling, refreshes, retries, and schedules
- Official YouTube Data API and GitHub REST API integrations
- Docker Compose and Caddy for the existing Contabo VPS

The decision-complete product and engineering contract is in
[`docs/SPEC.md`](docs/SPEC.md). Deployment, backup, restore, and incident steps
are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Local demo

Prerequisites: Node.js 24+ and npm 11+.

Create `.env.local`:

```dotenv
DEMO_MODE=true
DEMO_USER_ROLE=admin
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Then run:

```sh
npm ci
npm run dev
```

The demo is explicit and in-memory. It is refused when `NODE_ENV=production`,
so a deployed instance cannot silently fall back to sample data or bypass
Clerk.

## Production configuration

Copy `.env.example` to `.env.production` on the server and replace every
required placeholder. Production fails closed without PostgreSQL, Clerk,
health-check, and YouTube credentials. Never expose PostgreSQL or
the worker directly to the internet, and never commit `.env.production`.

The first deployment from `/opt/hardware` is:

```sh
chmod 700 deploy/*.sh
ENV_FILE=/opt/hardware/.env.production deploy/deploy.sh
```

PostgreSQL, the migration job, web process, and worker stay on a private Docker
network. Caddy is the only public service. The one-shot migrator initializes
both the application schema and Graphile Worker's schema before imports can be
accepted.

## Quality gates

```sh
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
```

Unit tests use deterministic fixtures and never call live providers. The golden
YouTube fixture asserts exactly 20 accepted timestamped projects while rejecting
intro, sponsor, newsletter, and social links. Browser tests run against explicit
demo mode; production integration checks require an isolated PostgreSQL database
and configured test credentials.

## Runtime model

1. An admin adds a channel, video, website, or GitHub repository.
2. The API writes a visible domain job and atomically queues durable work.
3. Workers fetch official provider data, parse conservatively, and upsert
   projects, links, sightings, and repository candidates idempotently.
4. Search covers catalog fields, source titles, repository metadata, visible
   collections, and only the requesting user's private notes.
5. Automatic repository attachment is limited to verified identity or an
   unambiguous source link. Search-derived candidates require an admin decision.

Every catalog claim retains its source video, timestamp, raw description
segment, original URL, normalized URL, parser version, and ingestion time.

## Useful commands

- `npm run dev` — start the web app
- `npm run worker:dev` — start the job worker against `.env.local`
- `npm run db:migrate` — apply Drizzle and Graphile Worker migrations
- `npm run db:generate` — generate a migration after an intentional schema edit
- `npm run db:studio` — inspect a local database
- `npm run test:all` — run the main pre-release gate

Hardware is private-alpha software. Keep sign-up invitation-only in Clerk and
complete the launch checklist in the operations runbook before exposing it.
