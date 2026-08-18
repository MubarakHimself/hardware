import "server-only";
import { getPool } from "../../db/index";
import { getServerConfig } from "./config";
import { ApiError } from "./errors";
import { isAuthorizedProbeRequest } from "./probe-auth";

interface RuntimeControlState {
  draining: boolean;
}

const runtimeControlStateKey = Symbol.for("hardware.runtime-control.state");

function runtimeControlState(): RuntimeControlState {
  const scope = globalThis as typeof globalThis & {
    [key: symbol]: RuntimeControlState | undefined;
  };
  const current = scope[runtimeControlStateKey];
  if (current) return current;
  const created = { draining: false };
  scope[runtimeControlStateKey] = created;
  return created;
}

function runtimeToken(): string {
  const config = getServerConfig();
  if (config.mode !== "local") {
    throw new ApiError({
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: "The desktop runtime endpoint is not available.",
    });
  }
  return config.desktopSessionToken ?? config.healthcheckToken;
}

export function requireDesktopRuntimeToken(request: Request): void {
  if (!isAuthorizedProbeRequest(request, runtimeToken())) {
    throw new ApiError({
      status: 401,
      code: "desktop_runtime_authentication_required",
      title: "Authentication required",
      detail: "A valid desktop runtime token is required.",
      headers: { "www-authenticate": "Bearer" },
    });
  }
}

export function isRuntimeDraining(): boolean {
  return runtimeControlState().draining;
}

export function setRuntimeDraining(value: boolean): { draining: boolean } {
  runtimeControlState().draining = value;
  return { draining: value };
}

export function assertRuntimeAcceptingMutations(request: Request): void {
  if (!runtimeControlState().draining) return;
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/internal/runtime/")) return;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  throw new ApiError({
    status: 503,
    code: "runtime_draining",
    title: "Hardware is closing",
    detail: "Hardware is finishing active requests and is not accepting new changes.",
    headers: { "retry-after": "5" },
  });
}

export async function desktopRuntimeReadiness(request: Request) {
  requireDesktopRuntimeToken(request);
  const config = getServerConfig();
  if (config.mode !== "local") {
    throw new Error("Desktop readiness requires local mode.");
  }

  let row:
    | {
        workerReady: boolean;
        catalogReady: boolean;
      }
    | undefined;
  try {
    const result = await getPool().query<{
      workerReady: boolean;
      catalogReady: boolean;
    }>(
      `select
         exists (
           select 1 from worker_heartbeats
            where last_seen_at >= now() - interval '60 seconds'
         ) as "workerReady",
         to_regclass('public.projects') is not null
           and to_regclass('public.ingestion_jobs') is not null
           as "catalogReady"`,
    );
    row = result.rows[0];
  } catch {
    throw new ApiError({
      status: 503,
      code: "dependencies_not_ready",
      title: "Service unavailable",
      detail: "The database or background worker is not ready.",
      headers: { "retry-after": "2" },
    });
  }

  if (!row?.workerReady || !row.catalogReady) {
    throw new ApiError({
      status: 503,
      code: "dependencies_not_ready",
      title: "Service unavailable",
      detail: "The database, background worker, or catalog is not ready.",
      headers: { "retry-after": "2" },
    });
  }

  return {
    status: "ready" as const,
    database: "ready" as const,
    worker: "ready" as const,
    catalog: "ready" as const,
    draining: runtimeControlState().draining,
    release: config.releaseSha,
  };
}

export async function activeRuntimeWork(request: Request) {
  requireDesktopRuntimeToken(request);
  const result = await getPool().query<{
    type: string;
    queued: number | string;
    running: number | string;
  }>(
    `select type::text as type,
            count(*) filter (where state = 'queued')::int as queued,
            count(*) filter (where state = 'running')::int as running
       from ingestion_jobs
      where state in ('queued', 'running')
      group by type
      order by type`,
  );
  const byType = result.rows.map((row) => ({
    type: row.type,
    queued: Number(row.queued),
    running: Number(row.running),
  }));
  const queued = byType.reduce((total, row) => total + row.queued, 0);
  const running = byType.reduce((total, row) => total + row.running, 0);
  return { queued, running, total: queued + running, byType };
}
