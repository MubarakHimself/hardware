import { IntegrationError, parseRetryAfter, requestJson } from "./http";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/u;

interface GitHubErrorBody { message?: string }
interface GitHubLicense { spdx_id?: string | null }
interface GitHubRepositoryBody extends GitHubErrorBody {
  id?: number;
  name?: string;
  full_name?: string;
  owner?: { login?: string };
  html_url?: string;
  homepage?: string | null;
  description?: string | null;
  default_branch?: string;
  topics?: string[];
  language?: string | null;
  license?: GitHubLicense | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  archived?: boolean;
  fork?: boolean;
  private?: boolean;
  pushed_at?: string | null;
}
interface GitHubSearchBody extends GitHubErrorBody {
  items?: GitHubRepositoryBody[];
}
interface GitHubCommitBody extends GitHubErrorBody { sha?: string }
interface GitHubReleaseBody extends GitHubErrorBody { published_at?: string | null; created_at?: string | null }

export interface GitHubRepositoryReference { owner: string; name: string; canonicalUrl: string }
export interface GitHubRepositoryMetadata extends GitHubRepositoryReference {
  providerRepositoryId: string;
  homepageUrl?: string;
  description?: string;
  defaultBranch?: string;
  headSha?: string;
  topics: string[];
  primaryLanguage?: string;
  languages: Record<string, number>;
  licenseSpdx?: string;
  stars: number;
  forks: number;
  openIssues: number;
  archived: boolean;
  fork: boolean;
  pushedAt?: string;
  latestReleaseAt?: string;
}

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

export function parseGitHubRepositoryReference(input: string): GitHubRepositoryReference {
  const source = input.trim();
  let owner: string | undefined;
  let name: string | undefined;
  if (!source.includes("://") && source.split("/").length === 2) {
    [owner, name] = source.split("/");
  } else {
    let url: URL;
    try { url = new URL(source); } catch {
      throw new IntegrationError({ provider: "github", code: "GITHUB_INVALID_REPOSITORY", message: "Use a public GitHub repository URL.", retryable: false });
    }
    if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") {
      throw new IntegrationError({ provider: "github", code: "GITHUB_INVALID_REPOSITORY", message: "The repository URL must be hosted by GitHub.", retryable: false });
    }
    [owner, name] = url.pathname.split("/").filter(Boolean);
  }
  name = name?.replace(/\.git$/iu, "");
  if (!owner || !name || !OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(name)) {
    throw new IntegrationError({ provider: "github", code: "GITHUB_INVALID_REPOSITORY", message: "Use a complete owner/repository GitHub URL.", retryable: false });
  }
  return { owner: owner.toLowerCase(), name: name.toLowerCase(), canonicalUrl: `https://github.com/${owner.toLowerCase()}/${name.toLowerCase()}` };
}

function githubError(status: number, body: GitHubErrorBody, headers: Headers): IntegrationError {
  const rateLimited = status === 429 || (status === 403 && headers.get("x-ratelimit-remaining") === "0");
  const retryable = rateLimited || status >= 500;
  return new IntegrationError({
    provider: "github",
    code: rateLimited ? "GITHUB_RATE_LIMITED" : status === 401 || status === 403 ? "GITHUB_CREDENTIALS_REJECTED" : status === 404 ? "GITHUB_NOT_FOUND" : status >= 500 ? "GITHUB_UPSTREAM_ERROR" : "GITHUB_REQUEST_REJECTED",
    message: rateLimited ? "GitHub API rate limit is temporarily exhausted." : status === 404 ? "The public GitHub repository does not exist." : "GitHub rejected the API request.",
    retryable,
    status,
    retryAfterMs: parseRetryAfter(headers.get("retry-after")),
  });
}

function boundedInteger(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}

export class GitHubClient {
  private readonly token?: string;
  private readonly baseUrl: URL;
  private readonly fetchImplementation?: typeof fetch;
  private readonly timeoutMs?: number;

  constructor(options: GitHubClientOptions = {}) {
    this.token = options.token?.trim() || undefined;
    this.baseUrl = new URL(options.baseUrl ?? "https://api.github.com/");
    this.fetchImplementation = options.fetchImplementation;
    this.timeoutMs = options.timeoutMs;
  }

  private async request<T extends GitHubErrorBody>(path: string, allowNotFound = false): Promise<T | undefined> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "hardware-ingestion/1.0",
      "x-github-api-version": "2022-11-28",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await requestJson<T>("github", new URL(path, this.baseUrl), { fetchImplementation: this.fetchImplementation, timeoutMs: this.timeoutMs, headers });
    if (allowNotFound && response.status === 404) return undefined;
    if (response.status < 200 || response.status >= 300) throw githubError(response.status, response.data, response.headers);
    return response.data;
  }

  private mapSummary(body: GitHubRepositoryBody): GitHubRepositoryMetadata {
    const id = body.id;
    const owner = body.owner?.login;
    const name = body.name;
    if (!id || !owner || !name || !body.html_url) {
      throw new IntegrationError({ provider: "github", code: "GITHUB_INVALID_RESPONSE", message: "GitHub returned incomplete repository data.", retryable: true });
    }
    if (body.private) throw new IntegrationError({ provider: "github", code: "GITHUB_PRIVATE_REPOSITORY", message: "Only public GitHub repositories can be indexed.", retryable: false });
    return {
      providerRepositoryId: String(id),
      owner: owner.toLowerCase(),
      name: name.toLowerCase(),
      canonicalUrl: `https://github.com/${owner.toLowerCase()}/${name.toLowerCase()}`,
      homepageUrl: body.homepage || undefined,
      description: body.description || undefined,
      defaultBranch: body.default_branch,
      topics: Array.isArray(body.topics) ? body.topics.filter((topic): topic is string => typeof topic === "string") : [],
      primaryLanguage: body.language || undefined,
      languages: {},
      licenseSpdx: body.license?.spdx_id && body.license.spdx_id !== "NOASSERTION" ? body.license.spdx_id : undefined,
      stars: boundedInteger(body.stargazers_count),
      forks: boundedInteger(body.forks_count),
      openIssues: boundedInteger(body.open_issues_count),
      archived: body.archived === true,
      fork: body.fork === true,
      pushedAt: body.pushed_at || undefined,
    };
  }

  async getRepository(input: string | GitHubRepositoryReference): Promise<GitHubRepositoryMetadata> {
    const reference = typeof input === "string" ? parseGitHubRepositoryReference(input) : input;
    const path = `repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
    const repositoryBody = await this.request<GitHubRepositoryBody>(path);
    if (!repositoryBody) throw new IntegrationError({ provider: "github", code: "GITHUB_NOT_FOUND", message: "The public GitHub repository does not exist.", retryable: false });
    const repository = this.mapSummary(repositoryBody);
    const branch = repository.defaultBranch;
    const [languages, release, commit] = await Promise.all([
      this.request<Record<string, number> & GitHubErrorBody>(`${path}/languages`),
      this.request<GitHubReleaseBody>(`${path}/releases/latest`, true),
      branch ? this.request<GitHubCommitBody>(`${path}/commits/${encodeURIComponent(branch)}`, true) : Promise.resolve(undefined),
    ]);
    repository.languages = Object.fromEntries(Object.entries(languages ?? {}).filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
    repository.latestReleaseAt = release?.published_at ?? release?.created_at ?? undefined;
    repository.headSha = commit?.sha;
    return repository;
  }

  async searchRepositories(query: string, limit = 5): Promise<GitHubRepositoryMetadata[]> {
    const cleanQuery = query.trim().slice(0, 200);
    if (!cleanQuery) return [];
    const url = new URL("search/repositories", this.baseUrl);
    url.searchParams.set("q", `${cleanQuery} in:name,description`);
    url.searchParams.set("sort", "stars");
    url.searchParams.set("per_page", String(Math.max(1, Math.min(limit, 10))));
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "hardware-ingestion/1.0", "x-github-api-version": "2022-11-28" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await requestJson<GitHubSearchBody>("github", url, { fetchImplementation: this.fetchImplementation, timeoutMs: this.timeoutMs, headers });
    if (response.status < 200 || response.status >= 300) throw githubError(response.status, response.data, response.headers);
    return (response.data.items ?? []).flatMap((item) => {
      try { return [this.mapSummary(item)]; } catch { return []; }
    });
  }
}
