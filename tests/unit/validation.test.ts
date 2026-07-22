import { describe, expect, it } from "vitest";
import { AuthorizationError } from "../../lib/auth";
import {
  createProblem,
  getGitHubRepositoryIdentity,
  getYouTubeVideoId,
  importRequestSchema,
  isSafeImportUrlSyntax,
  parseProjectQuery,
  problemFromAuthorizationError,
  problemFromZodError,
  problemResponse,
} from "../../lib/validation";

describe("import request validation", () => {
  it("accepts each supported import kind", () => {
    expect(
      importRequestSchema.parse({
        kind: "youtube_video",
        url: "https://www.youtube.com/watch?v=KITOm0HitpY",
      }),
    ).toMatchObject({ kind: "youtube_video" });
    expect(
      importRequestSchema.parse({
        kind: "github_repository",
        url: "https://github.com/Egonex-AI/Understand-Anything",
      }),
    ).toMatchObject({ kind: "github_repository" });
    expect(
      importRequestSchema.parse({
        kind: "website",
        url: "https://example.com/product",
      }),
    ).toMatchObject({ kind: "website" });
  });

  it("rejects mismatched types, credentials, private hosts, and extra keys", () => {
    expect(
      importRequestSchema.safeParse({
        kind: "website",
        url: "https://github.com/owner/repo",
      }).success,
    ).toBe(false);
    expect(
      importRequestSchema.safeParse({
        kind: "website",
        url: "https://www.youtube.com/@example",
      }).success,
    ).toBe(false);
    expect(
      importRequestSchema.safeParse({
        kind: "website",
        url: "http://user:password@example.com",
      }).success,
    ).toBe(false);
    expect(
      importRequestSchema.safeParse({
        kind: "website",
        url: "http://169.254.169.254/latest/meta-data",
      }).success,
    ).toBe(false);
    expect(
      importRequestSchema.safeParse({
        kind: "website",
        url: "https://example.com",
        admin: true,
      }).success,
    ).toBe(false);
  });

  it("extracts exact provider identities", () => {
    expect(
      getYouTubeVideoId("https://youtu.be/KITOm0HitpY?t=100"),
    ).toBe("KITOm0HitpY");
    expect(
      getGitHubRepositoryIdentity("https://github.com/owner/repo.git"),
    ).toEqual({ owner: "owner", repository: "repo" });
    expect(
      getGitHubRepositoryIdentity("https://github.com/owner/repo/issues"),
    ).toBeNull();
  });

  it("treats syntax checks as fail-closed first-line SSRF protection", () => {
    expect(isSafeImportUrlSyntax("https://example.com")).toBe(true);
    expect(isSafeImportUrlSyntax("http://127.0.0.1:3000")).toBe(false);
    expect(isSafeImportUrlSyntax("http://[::1]/")).toBe(false);
    expect(isSafeImportUrlSyntax("http://[::ffff:127.0.0.1]/")).toBe(false);
    expect(isSafeImportUrlSyntax("https://[2606:4700:4700::1111]/")).toBe(true);
    expect(isSafeImportUrlSyntax("file:///etc/passwd")).toBe(false);
    expect(
      isSafeImportUrlSyntax("https://example.com/project?access_token=secret"),
    ).toBe(false);
    expect(
      isSafeImportUrlSyntax("https://example.com/project?utm_source=video"),
    ).toBe(true);
  });
});

describe("project query validation", () => {
  it("trims input and applies deterministic defaults", () => {
    expect(parseProjectQuery(new URLSearchParams("q=%20graph%20"))).toEqual({
      q: "graph",
      sort: "relevance",
      view: "cards",
      limit: 24,
    });
    expect(parseProjectQuery({})).toEqual({
      sort: "recently_seen",
      view: "cards",
      limit: 24,
    });
  });

  it("parses filters without coercing false to true", () => {
    const query = parseProjectQuery(
      new URLSearchParams(
        "repository=pending&activity=90d&impressive=false&view=list&limit=100",
      ),
    );
    expect(query).toMatchObject({
      repository: "pending",
      activity: "90d",
      impressive: false,
      view: "list",
      limit: 100,
    });
  });

  it("rejects unknown, duplicated, malformed, and over-limit values", () => {
    expect(() => parseProjectQuery({ unknown: "value" })).toThrow();
    expect(() =>
      parseProjectQuery(new URLSearchParams("view=cards&view=list")),
    ).toThrow();
    expect(() => parseProjectQuery({ impressive: "yes" })).toThrow();
    expect(() => parseProjectQuery({ limit: "101" })).toThrow();
    expect(() => parseProjectQuery({ cursor: "not+a+base64url" })).toThrow();
  });
});

describe("RFC 9457 problems", () => {
  it("creates a standards-shaped problem response", async () => {
    const problem = createProblem({
      type: "urn:hardware:problem:not-found",
      title: "Not found",
      status: 404,
      detail: "The project does not exist.",
      correlationId: "corr_123",
    });
    const response = problemResponse(problem);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-correlation-id")).toBe("corr_123");
    expect(await response.json()).toEqual(problem);
  });

  it("maps structured validation issues to invalid-params", () => {
    const result = importRequestSchema.safeParse({
      kind: "youtube_video",
      url: "https://example.com/not-youtube",
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    const problem = problemFromZodError(result.error);
    expect(problem.status).toBe(422);
    expect(problem.code).toBe("validation_failed");
    expect(problem["invalid-params"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "url" })]),
    );
  });

  it("maps authentication and authorization failures without exposing internals", () => {
    expect(
      problemFromAuthorizationError(
        new AuthorizationError("authentication_required"),
      ),
    ).toMatchObject({
      type: "urn:hardware:problem:authentication_required",
      title: "Authentication required",
      status: 401,
      code: "authentication_required",
    });
    expect(
      problemFromAuthorizationError(new AuthorizationError("forbidden")),
    ).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("rejects non-error status codes", () => {
    expect(() => createProblem({ title: "No", status: 200 })).toThrow(
      RangeError,
    );
  });
});
