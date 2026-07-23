import "server-only";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { AuthorizationError } from "../auth";
import {
  createProblem,
  problemFromAuthorizationError,
  problemFromZodError,
  problemResponse,
} from "../validation";
import { getServerConfig, ServerConfigurationError } from "./config";
import { ApiError } from "./errors";
import { isAllowedLocalOrigin } from "./local-request";
import { serverLogger } from "./logger";

const MAX_JSON_BYTES = 64 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ApiContext {
  correlationId: string;
  instance: string;
}

type ApiHandler = (context: ApiContext) => Promise<Response>;

function correlationIdFor(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  return candidate && UUID.test(candidate) ? candidate : randomUUID();
}

function postgresError(error: unknown): ApiError | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = String(error.code);
  if (code === "23505") {
    return new ApiError({
      status: 409,
      code: "unique_conflict",
      title: "Conflict",
      detail: "A record with the same identity already exists.",
    });
  }
  if (code === "23503") {
    return new ApiError({
      status: 409,
      code: "referential_conflict",
      title: "Conflict",
      detail: "The requested change conflicts with a related record.",
    });
  }
  if (code === "22P02") {
    return new ApiError({
      status: 422,
      code: "invalid_identifier",
      title: "Validation failed",
      detail: "One of the supplied identifiers is invalid.",
    });
  }
  return null;
}

export async function withApiHandler(
  request: Request,
  handler: ApiHandler,
): Promise<Response> {
  const correlationId = correlationIdFor(request);
  const instance = new URL(request.url).pathname;

  try {
    return await handler({ correlationId, instance });
  } catch (error) {
    if (error instanceof ZodError) {
      return problemResponse(
        problemFromZodError(error, { correlationId, instance }),
      );
    }

    if (error instanceof AuthorizationError) {
      return problemResponse(
        problemFromAuthorizationError(error, { correlationId, instance }),
      );
    }

    const databaseProblem = postgresError(error);
    const apiError = error instanceof ApiError ? error : databaseProblem;
    if (apiError) {
      return problemResponse(
        createProblem({
          type: apiError.type,
          title: apiError.title,
          status: apiError.status,
          detail: apiError.message,
          code: apiError.code,
          correlationId,
          instance,
        }),
        { headers: apiError.headers },
      );
    }

    if (error instanceof ServerConfigurationError) {
      serverLogger.error({ event: "server_configuration_invalid", correlationId });
      return problemResponse(
        createProblem({
          type: "urn:hardware:problem:service-unavailable",
          title: "Service unavailable",
          status: 503,
          detail: "Hardware is not configured for this runtime.",
          code: "service_unavailable",
          correlationId,
          instance,
        }),
      );
    }

    serverLogger.error({
      event: "api_request_failed",
      correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode:
        error && typeof error === "object" && "code" in error
          ? String(error.code).slice(0, 80)
          : "UNCLASSIFIED",
    });
    return problemResponse(
      createProblem({
        type: "urn:hardware:problem:internal-error",
        title: "Internal server error",
        status: 500,
        detail: "The request could not be completed.",
        code: "internal_error",
        correlationId,
        instance,
      }),
    );
  }
}

export function successResponse<T>(
  data: T,
  options: {
    status?: number;
    meta?: Record<string, unknown>;
    correlationId?: string;
  } = {},
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
  });
  if (options.correlationId) {
    headers.set("x-correlation-id", options.correlationId);
  }
  return new Response(
    JSON.stringify({
      data,
      ...(options.meta ? { meta: options.meta } : {}),
    }),
    { status: options.status ?? 200, headers },
  );
}

async function readLimitedText(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new ApiError({
      status: 413,
      code: "payload_too_large",
      title: "Payload too large",
      detail: "JSON request bodies are limited to 64 KiB.",
    });
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new ApiError({
        status: 413,
        code: "payload_too_large",
        title: "Payload too large",
        detail: "JSON request bodies are limited to 64 KiB.",
      });
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new ApiError({
      status: 415,
      code: "unsupported_media_type",
      title: "Unsupported media type",
      detail: "Use application/json for this request.",
    });
  }

  const text = await readLimitedText(request);
  if (text.trim() === "") {
    throw new ApiError({
      status: 422,
      code: "empty_json_body",
      title: "Validation failed",
      detail: "A JSON request body is required.",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError({
      status: 400,
      code: "invalid_json",
      title: "Invalid JSON",
      detail: "The request body is not valid JSON.",
    });
  }
}

export function requireSameOrigin(request: Request): void {
  const config = getServerConfig();
  if (!isAllowedLocalOrigin(request.headers.get("origin"), config.appOrigin)) {
    throw new AuthorizationError("forbidden");
  }
}
