import type { ZodError } from "zod";
import type { AuthorizationError } from "../auth";

export interface InvalidParameter {
  name: string;
  reason: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  correlationId?: string;
  "invalid-params"?: InvalidParameter[];
}

export interface CreateProblemInput {
  status: number;
  title: string;
  type?: string;
  detail?: string;
  instance?: string;
  code?: string;
  correlationId?: string;
  invalidParams?: InvalidParameter[];
}

export function createProblem(input: CreateProblemInput): ProblemDetails {
  if (!Number.isInteger(input.status) || input.status < 400 || input.status > 599) {
    throw new RangeError("Problem status must be an integer from 400 through 599.");
  }

  return {
    type: input.type ?? "about:blank",
    title: input.title,
    status: input.status,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.instance ? { instance: input.instance } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.invalidParams?.length
      ? { "invalid-params": input.invalidParams }
      : {}),
  };
}

export function problemFromZodError(
  error: ZodError,
  options: Pick<CreateProblemInput, "instance" | "correlationId"> = {},
): ProblemDetails {
  return createProblem({
    type: "urn:hardware:problem:validation",
    title: "Validation failed",
    status: 422,
    detail: "One or more request values are invalid.",
    code: "validation_failed",
    ...options,
    invalidParams: error.issues.map((issue) => ({
      name: issue.path.length > 0 ? issue.path.join(".") : "request",
      reason: issue.message,
    })),
  });
}

export function problemFromAuthorizationError(
  error: Pick<AuthorizationError, "code" | "message" | "status">,
  options: Pick<CreateProblemInput, "instance" | "correlationId"> = {},
): ProblemDetails {
  return createProblem({
    type: `urn:hardware:problem:${error.code}`,
    title:
      error.status === 401 ? "Authentication required" : "Permission denied",
    status: error.status,
    detail:
      error.status === 401
        ? "Authentication is required."
        : "You do not have permission to perform this action.",
    code: error.code,
    ...options,
  });
}

export function problemResponse(
  problem: ProblemDetails,
  init: Omit<ResponseInit, "status"> = {},
): Response {
  if (
    !Number.isInteger(problem.status) ||
    problem.status < 400 ||
    problem.status > 599
  ) {
    throw new RangeError("Problem status must be an integer from 400 through 599.");
  }

  const headers = new Headers(init.headers);
  headers.set("content-type", "application/problem+json; charset=utf-8");
  headers.set("cache-control", "no-store");
  if (problem.correlationId) {
    headers.set("x-correlation-id", problem.correlationId);
  }

  return new Response(JSON.stringify(problem), {
    ...init,
    status: problem.status,
    headers,
  });
}
