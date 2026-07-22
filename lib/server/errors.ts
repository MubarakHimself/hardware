import "server-only";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly type: string;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(options: {
    status: number;
    code: string;
    title: string;
    detail: string;
    type?: string;
    headers?: Readonly<Record<string, string>>;
  }) {
    super(options.detail);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.type = options.type ?? `urn:hardware:problem:${options.code}`;
    this.headers = options.headers;
  }
}

export function notFound(detail: string): ApiError {
  return new ApiError({
    status: 404,
    code: "not_found",
    title: "Not found",
    detail,
  });
}

export function conflict(code: string, detail: string): ApiError {
  return new ApiError({
    status: 409,
    code,
    title: "Conflict",
    detail,
  });
}

export function unprocessable(code: string, detail: string): ApiError {
  return new ApiError({
    status: 422,
    code,
    title: "Validation failed",
    detail,
  });
}
