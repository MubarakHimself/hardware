import "server-only";
import type { QueryResultRow } from "pg";
import { z } from "zod";
import { getPool } from "../../db/index";
import { canReadCollection } from "../auth";
import type { AuthenticatedActor, ProjectSearchQuery } from "../domain";
import type { DemoProject } from "../demo/types";
import { normalizeProjectUrl } from "../ingestion";
import { getServerConfig } from "./config";
import { decodeOffsetCursor, encodeOffsetCursor } from "./cursor";
import { getDemoState } from "./demo-store";
import { notFound } from "./errors";

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  primaryUrl: string | null;
  logoUrl: string | null;
  reviewState: string;
  repositoryState: "none" | "pending" | "attached";
  repository: null | {
    id?: string;
    owner: string;
    name: string;
    canonicalUrl: string;
    primaryLanguage: string | null;
    license: string | null;
    stars: number;
    topics: string[];
    pushedAt?: string | null;
  };
  latestSighting: null | {
    videoId: string;
    videoTitle: string | null;
    channelId: string;
    channelTitle: string;
    timestampLabel: string;
    timestampSeconds: number;
    seenAt: string | null;
  };
  sightingCount: number;
  collectionIds: string[];
  isImpressive: boolean;
  note?: string | null;
}

export interface ProjectPage {
  projects: ProjectSummary[];
  nextCursor: string | null;
  facets: {
    channels: Array<{
      id: string;
      name: string;
      handle: string | null;
      projectCount: number;
    }>;
    languages: Array<{
      id: string;
      name: string;
      projectCount: number;
    }>;
    licenses: Array<{
      id: string;
      name: string;
      projectCount: number;
    }>;
    collections: Array<{
      id: string;
      name: string;
      projectCount: number;
    }>;
  };
}

function demoSummary(project: DemoProject): ProjectSummary {
  const latest = project.sightings[0];
  const repositoryParts = project.repositoryLabel?.split("/") ?? [];
  const channel = latest
    ? getDemoState().channels.find(
        (item) =>
          item.name === latest.channel || item.handle === latest.channelHandle,
      )
    : undefined;
  return {
    id: project.id,
    slug: project.id,
    name: project.name,
    description: project.description,
    primaryUrl: project.primaryUrl,
    logoUrl: project.logoUrl ?? null,
    reviewState:
      project.reviewState ?? (project.isNew ? "unreviewed" : "reviewed"),
    repositoryState:
      project.repositoryState === "verified"
        ? "attached"
        : project.repositoryState === "candidate"
          ? "pending"
          : "none",
    repository:
      project.repositoryState === "verified" && project.repositoryUrl
        ? {
            id: `demo-repository-${project.id}`,
            owner: repositoryParts[0] ?? "",
            name: repositoryParts[1] ?? project.name,
            canonicalUrl: project.repositoryUrl,
            primaryLanguage: project.language ?? null,
            license: project.license ?? null,
            stars: project.stars ?? 0,
            topics: project.topics,
            pushedAt: null,
          }
        : null,
    latestSighting: latest
      ? {
          videoId: latest.videoId,
          videoTitle: latest.videoTitle,
          channelId: channel?.id ?? latest.channelHandle,
          channelTitle: latest.channel,
          timestampLabel: latest.timestamp,
          timestampSeconds: latest.timestampSeconds,
          seenAt: latest.publishedAt,
        }
      : null,
    sightingCount: project.sightingCount,
    collectionIds: project.collectionIds,
    isImpressive: project.isImpressive ?? false,
    note: project.note ?? null,
  };
}

function listDemoProjects(
  actor: AuthenticatedActor,
  query: ProjectSearchQuery,
): ProjectPage {
  const offset = decodeOffsetCursor(query.cursor);
  const q = query.q?.toLocaleLowerCase();
  const state = getDemoState();
  const selectedChannel = query.channel
    ? state.channels.find((channel) => channel.id === query.channel)
    : undefined;
  let projects = state.projects.filter((project) => {
    const searchText = [
      project.name,
      project.description,
      project.primaryUrl,
      project.repositoryLabel,
      project.language,
      project.license,
      project.topics.join(" "),
      project.note,
      ...project.sightings.flatMap((sighting) => [
        sighting.channel,
        sighting.videoTitle,
      ]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    if (q && !searchText.includes(q)) return false;
    if (
      query.channel &&
      (!selectedChannel ||
        !project.sightings.some(
          (sighting) =>
            sighting.channel === selectedChannel.name ||
            sighting.channelHandle === selectedChannel.handle,
        ))
    ) {
      return false;
    }
    if (
      query.repository &&
      demoSummary(project).repositoryState !== query.repository
    ) {
      return false;
    }
    if (query.language && project.language?.toLowerCase() !== query.language.toLowerCase()) {
      return false;
    }
    if (query.license && project.license?.toLowerCase() !== query.license.toLowerCase()) {
      return false;
    }
    if (query.collection && !project.collectionIds.includes(query.collection)) return false;
    if (
      query.impressive !== undefined &&
      (project.isImpressive ?? false) !== query.impressive
    ) {
      return false;
    }
    if (query.activity === "30d" && project.activity === "quiet") return false;
    if (query.activity === "90d" && project.activity === "quiet") return false;
    if (query.activity === "stale" && project.activity !== "quiet") return false;
    return true;
  });

  projects = projects.sort((left, right) => {
    if (query.sort === "name") return left.name.localeCompare(right.name);
    if (query.sort === "repository_activity") {
      return right.activity.localeCompare(left.activity);
    }
    if (query.sort === "relevance" && q) {
      const leftExact = left.name.toLowerCase() === q ? 1 : 0;
      const rightExact = right.name.toLowerCase() === q ? 1 : 0;
      if (leftExact !== rightExact) return rightExact - leftExact;
    }
    return right.seenAt.localeCompare(left.seenAt);
  });

  const window = projects.slice(offset, offset + query.limit + 1);
  const hasNext = window.length > query.limit;
  return {
    projects: window.slice(0, query.limit).map(demoSummary),
    nextCursor: hasNext ? encodeOffsetCursor(offset + query.limit) : null,
    facets: {
      channels: state.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        handle: channel.handle,
        projectCount: state.projects.filter((project) =>
          project.sightings.some(
            (sighting) =>
              sighting.channel === channel.name ||
              sighting.channelHandle === channel.handle,
          ),
        ).length,
      })),
      languages: [...new Set(state.projects.map((project) => project.language).filter((value): value is string => Boolean(value)))]
        .sort((left, right) => left.localeCompare(right))
        .map((language) => ({
          id: language,
          name: language,
          projectCount: state.projects.filter(
            (project) => project.language === language,
          ).length,
        })),
      licenses: [...new Set(state.projects.map((project) => project.license).filter((value): value is string => Boolean(value)))]
        .sort((left, right) => left.localeCompare(right))
        .map((license) => ({
          id: license,
          name: license,
          projectCount: state.projects.filter(
            (project) => project.license === license,
          ).length,
        })),
      collections: state.collections
        .filter((collection) => canReadCollection(actor, collection))
        .map((collection) => ({
          id: collection.id,
          name: collection.name,
          projectCount: collection.projectIds.length,
        })),
    },
  };
}

function rowToSummary(row: QueryResultRow): ProjectSummary {
  const latestSighting = row.latestVideoId
    ? {
        videoId: String(row.latestVideoId),
        videoTitle: row.latestVideoTitle ? String(row.latestVideoTitle) : null,
        channelId: String(row.latestChannelId),
        channelTitle: String(row.latestChannelTitle),
        timestampLabel: String(row.latestTimestampLabel),
        timestampSeconds: Number(row.latestTimestampSeconds),
        seenAt: row.latestSeenAt ? new Date(row.latestSeenAt).toISOString() : null,
      }
    : null;
  const repository = row.repositoryId
    ? {
        id: String(row.repositoryId),
        owner: String(row.repositoryOwner),
        name: String(row.repositoryName),
        canonicalUrl: String(row.repositoryUrl),
        primaryLanguage: row.primaryLanguage ? String(row.primaryLanguage) : null,
        license: row.license ? String(row.license) : null,
        stars: Number(row.stars ?? 0),
        topics: Array.isArray(row.topics) ? row.topics.map(String) : [],
        pushedAt: row.pushedAt ? new Date(row.pushedAt).toISOString() : null,
      }
    : null;
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    primaryUrl: row.primaryUrl ? String(row.primaryUrl) : null,
    logoUrl: row.logoUrl ? String(row.logoUrl) : null,
    reviewState: String(row.reviewState),
    repositoryState: String(row.repositoryState) as ProjectSummary["repositoryState"],
    repository,
    latestSighting,
    sightingCount: Number(row.sightingCount ?? 0),
    collectionIds: Array.isArray(row.collectionIds)
      ? row.collectionIds.map(String)
      : [],
    isImpressive: Boolean(row.isImpressive),
    note: row.note ? String(row.note) : null,
  };
}

export async function listProjects(
  actor: AuthenticatedActor,
  query: ProjectSearchQuery,
): Promise<ProjectPage> {
  if (getServerConfig().mode === "demo") return listDemoProjects(actor, query);

  if (query.channel) z.string().uuid().parse(query.channel);
  if (query.collection) z.string().uuid().parse(query.collection);

  const values: unknown[] = [];
  const parameter = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const actorParameter = parameter(actor.userId);
  const where = ["p.state = 'active'"];
  let rankSql = "0::double precision";

  if (query.q) {
    const q = parameter(query.q);
    const projectVector = `to_tsvector(
      'simple',
      coalesce(p.name, '') || ' ' || coalesce(p.description, '') || ' ' ||
      coalesce(p.primary_url, '') || ' ' || coalesce(p.normalized_primary_url, '')
    )`;
    const repositoryVector = `to_tsvector(
      'simple',
      coalesce(r.owner, '') || ' ' || coalesce(r.name, '') || ' ' ||
      coalesce(r.description, '') || ' ' || coalesce(r.primary_language, '') || ' ' ||
      coalesce(r.license_spdx, '') || ' ' || coalesce(r.topics::text, '')
    )`;
    rankSql = `
      case
        when lower(p.name) = lower(${q}) or lower(coalesce(p.primary_url, '')) = lower(${q}) then 400
        when p.name ilike (${q} || '%') then 300
        when ${projectVector} @@ plainto_tsquery('simple', ${q})
          then 200 + ts_rank_cd(${projectVector}, plainto_tsquery('simple', ${q}))
        when ${repositoryVector} @@ plainto_tsquery('simple', ${q}) then 150
        when lower(p.name) % lower(${q}) then 100 + similarity(lower(p.name), lower(${q}))
        else 50
      end
    `;
    where.push(`(
      ${projectVector} @@ plainto_tsquery('simple', ${q})
      or lower(p.name) like (lower(${q}) || '%')
      or lower(p.name) % lower(${q})
      or lower(coalesce(p.normalized_primary_url, '')) % lower(${q})
      or ${repositoryVector} @@ plainto_tsquery('simple', ${q})
      or lower(r.owner || '/' || r.name) % lower(${q})
      or exists (
        select 1 from project_aliases pa
         where pa.project_id = p.id and lower(pa.normalized_alias) % lower(${q})
      )
      or exists (
        select 1 from project_links pl
         where pl.project_id = p.id and lower(pl.normalized_url) % lower(${q})
      )
      or exists (
        select 1
          from sightings search_sighting
          join video_sources search_video on search_video.id = search_sighting.video_id
          join channel_sources search_channel on search_channel.id = search_sighting.channel_id
         where search_sighting.project_id = p.id
           and (
             to_tsvector('simple', coalesce(search_video.title, ''))
               @@ plainto_tsquery('simple', ${q})
             or lower(search_channel.title) % lower(${q})
           )
      )
      or exists (
        select 1
          from collection_projects search_membership
          join collections search_collection on search_collection.id = search_membership.collection_id
         where search_membership.project_id = p.id
           and (search_collection.owner_user_id = ${actorParameter}::uuid
                or search_collection.visibility = 'workspace')
           and lower(search_collection.name) % lower(${q})
      )
      or exists (
        select 1 from project_notes search_note
         where search_note.project_id = p.id
           and search_note.owner_user_id = ${actorParameter}::uuid
           and to_tsvector('simple', search_note.body)
               @@ plainto_tsquery('simple', ${q})
      )
    )`);
  }
  if (query.channel) {
    const value = parameter(query.channel);
    where.push(`exists (select 1 from sightings sf where sf.project_id = p.id and sf.channel_id = ${value}::uuid)`);
  }
  if (query.repository === "attached") where.push("r.id is not null");
  if (query.repository === "pending") {
    where.push("r.id is null and exists (select 1 from repository_candidates rc where rc.project_id = p.id and rc.state = 'pending')");
  }
  if (query.repository === "none") {
    where.push("r.id is null and not exists (select 1 from repository_candidates rc where rc.project_id = p.id and rc.state = 'pending')");
  }
  if (query.language) {
    const value = parameter(query.language);
    where.push(`lower(coalesce(r.primary_language, '')) = lower(${value})`);
  }
  if (query.license) {
    const value = parameter(query.license);
    where.push(`lower(coalesce(r.license_spdx, '')) = lower(${value})`);
  }
  if (query.activity === "30d") where.push("r.pushed_at >= now() - interval '30 days'");
  if (query.activity === "90d") where.push("r.pushed_at >= now() - interval '90 days'");
  if (query.activity === "stale") where.push("r.pushed_at is null or r.pushed_at < now() - interval '90 days'");
  if (query.collection) {
    const value = parameter(query.collection);
    where.push(`exists (
      select 1 from collection_projects cpf
      join collections cf on cf.id = cpf.collection_id
      where cpf.project_id = p.id and cf.id = ${value}::uuid
        and (cf.owner_user_id = ${actorParameter}::uuid or cf.visibility = 'workspace')
    )`);
  }
  if (query.impressive !== undefined) {
    const value = parameter(query.impressive);
    where.push(`coalesce(pref.is_impressive, false) = ${value}::boolean`);
  }

  const offset = decodeOffsetCursor(query.cursor);
  const limitParameter = parameter(query.limit + 1);
  const offsetParameter = parameter(offset);
  const orderBy: Record<ProjectSearchQuery["sort"], string> = {
    relevance: `"searchRank" desc, p.id`,
    newest: "p.created_at desc, p.id",
    recently_seen: "stats.seen_at desc nulls last, p.id",
    name: "lower(p.name), p.id",
    repository_activity: "r.pushed_at desc nulls last, p.id",
  };

  const result = await getPool().query(
    `
      select
        p.id,
        p.slug,
        p.name,
        p.description,
        p.primary_url as "primaryUrl",
        p.logo_url as "logoUrl",
        p.review_state as "reviewState",
        case
          when r.id is not null then 'attached'
          when exists (select 1 from repository_candidates rc where rc.project_id = p.id and rc.state = 'pending') then 'pending'
          else 'none'
        end as "repositoryState",
        r.id as "repositoryId",
        r.owner as "repositoryOwner",
        r.name as "repositoryName",
        r.canonical_url as "repositoryUrl",
        r.primary_language as "primaryLanguage",
        r.license_spdx as license,
        r.stars,
        r.topics,
        r.pushed_at as "pushedAt",
        latest.youtube_video_id as "latestVideoId",
        latest.video_title as "latestVideoTitle",
        latest.channel_id as "latestChannelId",
        latest.channel_title as "latestChannelTitle",
        latest.timestamp_label as "latestTimestampLabel",
        latest.timestamp_seconds as "latestTimestampSeconds",
        latest.ingested_at as "latestSeenAt",
        coalesce(stats.sighting_count, 0) as "sightingCount",
        coalesce(own_collections.collection_ids, array[]::text[]) as "collectionIds",
        coalesce(pref.is_impressive, false) as "isImpressive",
        note.body as note,
        ${rankSql} as "searchRank"
      from projects p
      left join repositories r on r.id = p.primary_repository_id
      left join project_preferences pref
        on pref.project_id = p.id and pref.owner_user_id = ${actorParameter}::uuid
      left join project_notes note
        on note.project_id = p.id and note.owner_user_id = ${actorParameter}::uuid
      left join lateral (
        select count(*)::int as sighting_count, max(s.ingested_at) as seen_at
        from sightings s where s.project_id = p.id
      ) stats on true
      left join lateral (
        select
          v.youtube_video_id,
          v.title as video_title,
          c.id as channel_id,
          c.title as channel_title,
          s.timestamp_label,
          s.timestamp_seconds,
          s.ingested_at
        from sightings s
        join video_sources v on v.id = s.video_id
        join channel_sources c on c.id = s.channel_id
        where s.project_id = p.id
        order by s.ingested_at desc, s.id desc
        limit 1
      ) latest on true
      left join lateral (
        select array_agg(cp.collection_id::text order by cp.created_at) as collection_ids
        from collection_projects cp
        join collections c on c.id = cp.collection_id
        where cp.project_id = p.id and c.owner_user_id = ${actorParameter}::uuid
      ) own_collections on true
      where ${where.join(" and ")}
      order by ${orderBy[query.sort]}
      limit ${limitParameter}::int offset ${offsetParameter}::int
    `,
    values,
  );

  const hasNext = result.rows.length > query.limit;
  const [channelFacets, languageFacets, licenseFacets, collectionFacets] =
    await Promise.all([
      getPool().query(
        `select c.id::text, c.title as name, c.handle,
                (count(distinct s.project_id) filter (where p.id is not null))::int as "projectCount"
           from channel_sources c
           left join sightings s on s.channel_id = c.id
           left join projects p on p.id = s.project_id and p.state = 'active'
          where c.enabled = true
          group by c.id
          order by c.title, c.id`,
      ),
      getPool().query(
        `select r.primary_language as id, r.primary_language as name,
                count(distinct p.id)::int as "projectCount"
           from projects p
           join repositories r on r.id = p.primary_repository_id
          where p.state = 'active'
            and r.primary_language is not null
            and btrim(r.primary_language) <> ''
          group by r.primary_language
          order by lower(r.primary_language), r.primary_language`,
      ),
      getPool().query(
        `select r.license_spdx as id, r.license_spdx as name,
                count(distinct p.id)::int as "projectCount"
           from projects p
           join repositories r on r.id = p.primary_repository_id
          where p.state = 'active'
            and r.license_spdx is not null
            and btrim(r.license_spdx) <> ''
          group by r.license_spdx
          order by lower(r.license_spdx), r.license_spdx`,
      ),
      getPool().query(
        `select c.id::text, c.name,
                (count(distinct cp.project_id) filter (where p.id is not null))::int as "projectCount"
           from collections c
           left join collection_projects cp on cp.collection_id = c.id
           left join projects p on p.id = cp.project_id and p.state = 'active'
          where c.owner_user_id = $1::uuid or c.visibility = 'workspace'
          group by c.id
          order by (c.owner_user_id = $1::uuid) desc, lower(c.name), c.id`,
        [actor.userId],
      ),
    ]);
  const simpleFacets = (rows: QueryResultRow[]) =>
    rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      projectCount: Number(row.projectCount ?? 0),
    }));
  return {
    projects: result.rows.slice(0, query.limit).map(rowToSummary),
    nextCursor: hasNext ? encodeOffsetCursor(offset + query.limit) : null,
    facets: {
      channels: channelFacets.rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        handle: row.handle ? String(row.handle) : null,
        projectCount: Number(row.projectCount ?? 0),
      })),
      languages: simpleFacets(languageFacets.rows),
      licenses: simpleFacets(licenseFacets.rows),
      collections: simpleFacets(collectionFacets.rows),
    },
  };
}

export async function getProjectDetail(
  actor: AuthenticatedActor,
  identifier: string,
): Promise<Record<string, unknown>> {
  if (getServerConfig().mode === "demo") {
    const state = getDemoState();
    let canonicalIdentifier = identifier;
    const visited = new Set<string>();
    while (
      state.projectRedirects.has(canonicalIdentifier) &&
      !visited.has(canonicalIdentifier)
    ) {
      visited.add(canonicalIdentifier);
      canonicalIdentifier = state.projectRedirects.get(canonicalIdentifier)!;
    }
    const project = state.projects.find(
      (item) => item.id === canonicalIdentifier,
    );
    if (!project) throw notFound("The project does not exist.");
    const repositoryParts = project.repositoryLabel?.split("/") ?? [];
    const normalizedPrimary = project.primaryUrl
      ? normalizeProjectUrl(project.primaryUrl)
      : null;
    const repository =
      project.repositoryState === "verified" && project.repositoryUrl
        ? {
            id: `demo-repository-${project.id}`,
            owner: repositoryParts[0] ?? "",
            name: repositoryParts[1] ?? project.name,
            canonicalUrl: project.repositoryUrl,
            description: null,
            defaultBranch: null,
            headSha: null,
            topics: [...project.topics],
            primaryLanguage: project.language ?? null,
            languages: {},
            licenseSpdx: project.license ?? null,
            stars: project.stars ?? 0,
            forks: 0,
            openIssues: 0,
            archived: false,
            pushedAt: null,
            latestReleaseAt: null,
          }
        : null;
    const sightings = project.sightings.map((sighting) => {
      const channel = state.channels.find(
        (item) =>
          item.name === sighting.channel ||
          item.handle === sighting.channelHandle,
      );
      const normalized = normalizeProjectUrl(sighting.originalUrl);
      return {
        id: sighting.id,
        timestampSeconds: sighting.timestampSeconds,
        timestampLabel: sighting.timestamp,
        rawSegment: sighting.rawSegment,
        originalUrl: sighting.originalUrl,
        normalizedUrl: normalized.ok
          ? normalized.link.canonicalUrl
          : sighting.originalUrl,
        parserVersion: "youtube-description/v1",
        ingestedAt: null,
        youtubeVideoId: sighting.videoId,
        videoTitle: sighting.videoTitle,
        publishedAt: sighting.publishedAt,
        channelId: channel?.id ?? sighting.channelHandle,
        channelTitle: sighting.channel,
        channelHandle: sighting.channelHandle,
      };
    });
    const primaryLink =
      project.primaryUrl && normalizedPrimary?.ok
        ? [
            {
              id: `demo-primary-${project.id}`,
              kind: "website",
              label: null,
              originalUrl: project.primaryUrl,
              normalizedUrl: normalizedPrimary.link.canonicalUrl,
              verificationState: "unverified",
              verifiedAt: null,
            },
          ]
        : [];
    const repositoryLink = project.repositoryUrl
      ? [
          {
            id: `demo-repository-link-${project.id}`,
            kind: "repository",
            label: project.repositoryLabel ?? null,
            originalUrl: project.repositoryUrl,
            normalizedUrl: project.repositoryUrl,
            verificationState: "verified",
            verifiedAt: null,
          },
        ]
      : [];
    return {
      id: project.id,
      slug: project.id,
      name: project.name,
      description: project.description || null,
      primaryUrl: project.primaryUrl || null,
      normalizedPrimaryUrl:
        normalizedPrimary?.ok === true
          ? normalizedPrimary.link.canonicalUrl
          : null,
      logoUrl: project.logoUrl ?? null,
      state: "active",
      reviewState:
        project.reviewState ?? (project.isNew ? "unreviewed" : "reviewed"),
      repositoryState:
        project.repositoryState === "verified"
          ? "attached"
          : project.repositoryState === "candidate"
            ? "pending"
            : "none",
      version: state.projectVersions.get(project.id) ?? 1,
      createdAt: null,
      updatedAt: null,
      repository,
      note: project.note
        ? {
            body: project.note,
            version: state.noteVersions.get(project.id) ?? 1,
          }
        : null,
      isImpressive: Boolean(project.isImpressive),
      collectionIds: [...project.collectionIds],
      sightings,
      links: [...primaryLink, ...repositoryLink, ...(project.additionalLinks ?? [])],
      history: state.audit
        .filter((event) => {
          const targetId = String(event.targetId ?? "");
          if (targetId === project.id) return true;
          let redirected = targetId;
          const seen = new Set<string>();
          while (
            state.projectRedirects.has(redirected) &&
            !seen.has(redirected)
          ) {
            seen.add(redirected);
            redirected = state.projectRedirects.get(redirected)!;
          }
          return redirected === project.id;
        })
        .map((event) => ({
          action: String(event.action),
          correlationId: event.correlationId
            ? String(event.correlationId)
            : null,
          beforeSummary: null,
          afterSummary: null,
          createdAt: event.createdAt ? String(event.createdAt) : null,
        })),
    };
  }

  const pool = getPool();
  const resolved = await pool.query(
    `with recursive seed as (
       select distinct p.id, p.state, p.merged_into_project_id, 0 as depth,
              array[p.id]::uuid[] as path
         from projects p
         left join project_aliases pa on pa.project_id = p.id
        where p.id::text = $1
           or p.slug = $1
           or lower(pa.normalized_alias) = lower($1)
     ), chain as (
       select * from seed
       union all
       select target.id, target.state, target.merged_into_project_id,
              chain.depth + 1, chain.path || target.id
         from chain
         join projects target on target.id = chain.merged_into_project_id
        where chain.state = 'merged'
          and chain.depth < 32
          and not target.id = any(chain.path)
     )
     select id
       from chain
      where state <> 'merged'
      order by depth desc
      limit 1`,
    [identifier],
  );
  const canonicalProjectId = resolved.rows[0]?.id
    ? String(resolved.rows[0].id)
    : null;
  if (!canonicalProjectId) throw notFound("The project does not exist.");
  const [projectResult, sightings, links, history, collections] = await Promise.all([
    pool.query(
      `
        select p.id, p.slug, p.name, p.description,
          p.primary_url as "primaryUrl", p.normalized_primary_url as "normalizedPrimaryUrl",
          p.logo_url as "logoUrl", p.state, p.review_state as "reviewState",
          case
            when p.primary_repository_id is not null then 'attached'
            when exists (
              select 1 from repository_candidates rc
               where rc.project_id = p.id and rc.state = 'pending'
            ) then 'pending'
            else 'none'
          end as "repositoryState",
          p.version, p.created_at as "createdAt", p.updated_at as "updatedAt",
          r.id as "repositoryId", r.owner as "repositoryOwner", r.name as "repositoryName",
          r.canonical_url as "repositoryUrl", r.description as "repositoryDescription",
          r.default_branch as "defaultBranch", r.head_sha as "headSha", r.topics,
          r.primary_language as "primaryLanguage", r.languages,
          r.license_spdx as "licenseSpdx", r.stars, r.forks,
          r.open_issues as "openIssues", r.archived as "repositoryArchived",
          r.pushed_at as "pushedAt", r.latest_release_at as "latestReleaseAt",
          n.body as "privateNote", n.version as "noteVersion",
          coalesce(pref.is_impressive, false) as "isImpressive"
        from projects p
        left join repositories r on r.id = p.primary_repository_id
        left join project_notes n on n.project_id = p.id and n.owner_user_id = $1::uuid
        left join project_preferences pref on pref.project_id = p.id and pref.owner_user_id = $1::uuid
        where p.id = $2::uuid and p.state <> 'merged'
        limit 1
      `,
      [actor.userId, canonicalProjectId],
    ),
    pool.query(
      `
        select s.id, s.timestamp_seconds as "timestampSeconds",
          s.timestamp_label as "timestampLabel", s.raw_segment as "rawSegment",
          s.original_url as "originalUrl", s.normalized_url as "normalizedUrl",
          s.parser_version as "parserVersion", s.ingested_at as "ingestedAt",
          v.youtube_video_id as "youtubeVideoId", v.title as "videoTitle",
          v.published_at as "publishedAt", c.id as "channelId",
          c.title as "channelTitle", c.handle as "channelHandle"
        from sightings s
        join video_sources v on v.id = s.video_id
        join channel_sources c on c.id = s.channel_id
        where s.project_id = $1::uuid
        order by s.ingested_at desc, s.id desc
      `,
      [canonicalProjectId],
    ),
    pool.query(
      `select l.id, l.kind, l.label, l.original_url as "originalUrl",
              l.normalized_url as "normalizedUrl",
              l.verification_state as "verificationState", l.verified_at as "verifiedAt"
         from project_links l
        where l.project_id = $1::uuid
        order by l.created_at, l.id`,
      [canonicalProjectId],
    ),
    pool.query(
      `with recursive project_family as (
         select id from projects where id = $1::uuid
         union
         select predecessor.id
           from projects predecessor
           join project_family family
             on predecessor.merged_into_project_id = family.id
       )
       select a.action, a.correlation_id as "correlationId",
              a.before_summary as "beforeSummary", a.after_summary as "afterSummary",
              a.created_at as "createdAt"
         from audit_events a
         join project_family family on a.target_id = family.id::text
        where a.target_type = 'project'
        order by a.created_at desc limit 100`,
      [canonicalProjectId],
    ),
    pool.query(
      `select c.id::text
         from collection_projects cp
         join collections c on c.id = cp.collection_id
        where c.owner_user_id = $1::uuid and cp.project_id = $2::uuid
        order by cp.created_at`,
      [actor.userId, canonicalProjectId],
    ),
  ]);

  const project = projectResult.rows[0];
  if (!project) throw notFound("The project does not exist.");
  const repository = project.repositoryId
    ? {
        id: project.repositoryId,
        owner: project.repositoryOwner,
        name: project.repositoryName,
        canonicalUrl: project.repositoryUrl,
        description: project.repositoryDescription,
        defaultBranch: project.defaultBranch,
        headSha: project.headSha,
        topics: project.topics ?? [],
        primaryLanguage: project.primaryLanguage,
        languages: project.languages ?? {},
        licenseSpdx: project.licenseSpdx,
        stars: project.stars ?? 0,
        forks: project.forks ?? 0,
        openIssues: project.openIssues ?? 0,
        archived: project.repositoryArchived ?? false,
        pushedAt: project.pushedAt,
        latestReleaseAt: project.latestReleaseAt,
      }
    : null;
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    primaryUrl: project.primaryUrl,
    normalizedPrimaryUrl: project.normalizedPrimaryUrl,
    logoUrl: project.logoUrl,
    state: project.state,
    reviewState: project.reviewState,
    repositoryState: project.repositoryState,
    version: project.version,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    repository,
    note: project.privateNote
      ? { body: project.privateNote, version: project.noteVersion }
      : null,
    isImpressive: Boolean(project.isImpressive),
    collectionIds: collections.rows.map((row) => String(row.id)),
    sightings: sightings.rows,
    links: links.rows,
    history: history.rows,
  };
}
