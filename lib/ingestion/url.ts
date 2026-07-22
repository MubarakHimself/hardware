import type {
  NormalizeProjectUrlResult,
  ParsedLink,
} from "./types";
import { hasSecretLikeQueryParameter } from "../validation/public-url";

export interface ExtractedUrlToken {
  rawUrl: string;
  start: number;
  end: number;
}

const TRACKING_PARAMETER_NAMES = new Set([
  "dclid",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref",
]);

const GITHUB_RESERVED_ROOTS = new Set([
  "about",
  "collections",
  "customer-stories",
  "enterprise",
  "events",
  "features",
  "login",
  "marketplace",
  "orgs",
  "pricing",
  "search",
  "settings",
  "signup",
  "sponsors",
  "topics",
]);

const URL_TOKEN_PATTERN =
  /(?:https?:\/\/|www\.)[^\s<>"'\u0000-\u001f]+/giu;

const SIMPLE_TRAILING_PUNCTUATION = /[.,;:!?\u2018\u2019\u201c\u201d]$/u;

function countCharacter(value: string, character: string): number {
  let count = 0;
  for (const current of value) {
    if (current === character) {
      count += 1;
    }
  }
  return count;
}

function trimUrlToken(candidate: string): string {
  let value = candidate;

  while (SIMPLE_TRAILING_PUNCTUATION.test(value)) {
    value = value.slice(0, -1);
  }

  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];

  let changed = true;
  while (changed && value.length > 0) {
    changed = false;
    for (const [opening, closing] of pairs) {
      if (
        value.endsWith(closing) &&
        countCharacter(value, closing) > countCharacter(value, opening)
      ) {
        value = value.slice(0, -1);
        changed = true;
      }
    }
  }

  return value;
}

/** Extract URL-shaped tokens without interpreting or fetching them. */
export function extractUrlTokens(text: string): ExtractedUrlToken[] {
  const tokens: ExtractedUrlToken[] = [];

  for (const match of text.matchAll(URL_TOKEN_PATTERN)) {
    const candidate = match[0];
    const start = match.index;
    const rawUrl = trimUrlToken(candidate);

    if (rawUrl.length === 0) {
      continue;
    }

    tokens.push({
      rawUrl,
      start,
      end: start + rawUrl.length,
    });
  }

  return tokens;
}

function isYouTubeHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com")
  );
}

function isTrackingParameter(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_PARAMETER_NAMES.has(normalized);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function githubRepoKey(url: URL): string | undefined {
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "www.github.com") {
    return undefined;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }

  const owner = safeDecodeURIComponent(segments[0]).toLowerCase();
  const repository = safeDecodeURIComponent(segments[1])
    .replace(/\.git$/iu, "")
    .toLowerCase();

  if (
    owner.length === 0 ||
    repository.length === 0 ||
    GITHUB_RESERVED_ROOTS.has(owner)
  ) {
    return undefined;
  }

  return `${owner}/${repository}`;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function canonicalize(url: URL): string {
  const canonical = new URL(url.toString());
  canonical.hash = "";

  const retainedEntries = [...canonical.searchParams.entries()]
    .filter(([name]) => !isTrackingParameter(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const nameOrder = compareText(leftName, rightName);
      return nameOrder === 0 ? compareText(leftValue, rightValue) : nameOrder;
    });

  canonical.search = "";
  for (const [name, value] of retainedEntries) {
    canonical.searchParams.append(name, value);
  }

  const root = `${canonical.protocol}//${canonical.host}`;
  const pathname = canonical.pathname === "/" ? "" : canonical.pathname;
  const search = canonical.searchParams.size > 0
    ? `?${canonical.searchParams.toString()}`
    : "";

  return `${root}${pathname}${search}`;
}

function invalid(
  code: Exclude<NormalizeProjectUrlResult, { ok: true }>["code"],
  message: string,
): NormalizeProjectUrlResult {
  return { ok: false, code, message };
}

/**
 * Convert a source URL into a conservative exact-match form.
 * This function deliberately does not perform DNS or HTTP requests.
 */
export function normalizeProjectUrl(rawUrl: string): NormalizeProjectUrlResult {
  const source = rawUrl.trim().replaceAll("&amp;", "&");
  let inferredScheme = /^www\./iu.test(source);
  let candidate = inferredScheme ? `https://${source}` : source;
  let parsed: URL;

  try {
    parsed = new URL(candidate);
  } catch {
    return invalid("INVALID_URL", "The URL is not syntactically valid.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return invalid("UNSUPPORTED_PROTOCOL", "Only HTTP(S) project URLs are allowed.");
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return invalid("URL_HAS_CREDENTIALS", "URLs containing credentials are rejected.");
  }

  if (hasSecretLikeQueryParameter(parsed)) {
    return invalid(
      "SENSITIVE_QUERY",
      "URLs containing secret-like query parameters are rejected.",
    );
  }

  if (isYouTubeHostname(parsed.hostname) && parsed.pathname === "/redirect") {
    const destination = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
    if (!destination) {
      return invalid(
        "UNRESOLVABLE_YOUTUBE_REDIRECT",
        "The YouTube redirect has no explicit q or url destination.",
      );
    }

    inferredScheme = /^www\./iu.test(destination);
    candidate = inferredScheme ? `https://${destination}` : destination;

    try {
      parsed = new URL(candidate);
    } catch {
      return invalid(
        "UNRESOLVABLE_YOUTUBE_REDIRECT",
        "The YouTube redirect destination is not a valid URL.",
      );
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return invalid(
        "UNRESOLVABLE_YOUTUBE_REDIRECT",
        "The YouTube redirect destination is not HTTP(S).",
      );
    }

    if (parsed.username.length > 0 || parsed.password.length > 0) {
      return invalid("URL_HAS_CREDENTIALS", "URLs containing credentials are rejected.");
    }
    if (hasSecretLikeQueryParameter(parsed)) {
      return invalid(
        "SENSITIVE_QUERY",
        "URLs containing secret-like query parameters are rejected.",
      );
    }
  }

  if (isYouTubeHostname(parsed.hostname)) {
    return invalid(
      "YOUTUBE_INTERNAL",
      "YouTube navigation links are not project destinations.",
    );
  }

  const repositoryKey = githubRepoKey(parsed);
  const link: ParsedLink = {
    rawUrl,
    resolvedUrl: parsed.toString(),
    canonicalUrl: canonicalize(parsed),
    kind: repositoryKey ? "github_repo" : "website",
    inferredScheme,
  };

  if (repositoryKey) {
    link.githubRepoKey = repositoryKey;
  }

  return { ok: true, link };
}
