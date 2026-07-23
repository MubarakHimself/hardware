import "server-only";
import { getPool } from "../../db/index";
import { getServerConfig } from "./config";
import { ApiError } from "./errors";
import { isAuthorizedProbeRequest } from "./probe-auth";

export async function readiness(request: Request) {
  const config = getServerConfig();
  if (config.mode === "demo") {
    return { status: "ready", mode: "demo", release: config.releaseSha };
  }

  if (!isAuthorizedProbeRequest(request, config.healthcheckToken)) {
    throw new ApiError({
      status: 401,
      code: "healthcheck_authentication_required",
      title: "Authentication required",
      detail: "A valid healthcheck token is required.",
      headers: { "www-authenticate": "Bearer" },
    });
  }

  let result;
  try {
    result = await getPool().query<{
      database_ready: boolean;
      worker_ready: boolean;
    }>(
      `select true as database_ready,
         exists (
           select 1 from worker_heartbeats
            where last_seen_at >= now() - interval '60 seconds'
         ) as worker_ready`,
    );
  } catch {
    throw new ApiError({
      status: 503,
      code: "dependencies_not_ready",
      title: "Service unavailable",
      detail: "The database or background worker is not ready.",
      headers: { "retry-after": "15" },
    });
  }
  const state = result.rows[0];
  if (!state?.database_ready || !state.worker_ready) {
    throw new ApiError({
      status: 503,
      code: "dependencies_not_ready",
      title: "Service unavailable",
      detail: "The database or background worker is not ready.",
      headers: { "retry-after": "15" },
    });
  }

  return {
    status: "ready",
    mode: "local",
    database: "ready",
    worker: "ready",
    release: config.releaseSha,
  };
}
