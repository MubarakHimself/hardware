import {
  safeFetchHtml,
  type SafeFetchOptions,
  type SafeHtmlFetchResult,
} from "./safe-fetch";
import { normalizeProjectUrl } from "./url";
import { hasSecretLikeQueryParameter } from "../validation/public-url";

const MAX_TAG_CHARACTERS = 32_768;
const MAX_ANCHORS_TO_INSPECT = 2_000;
const MAX_GITHUB_REPOSITORIES = 100;
const MAX_URL_CHARACTERS = 4_096;

export interface OpenGraphMetadata {
  title?: string;
  description?: string;
  imageUrl?: string;
  url?: string;
  siteName?: string;
  type?: string;
}

export interface GitHubRepositoryAnchor {
  repoKey: string;
  url: string;
}

export interface ExtractedWebsiteMetadata {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  iconUrl?: string;
  openGraph: OpenGraphMetadata;
  githubRepositories: GitHubRepositoryAnchor[];
}

export interface WebsiteMetadata extends ExtractedWebsiteMetadata {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: SafeHtmlFetchResult["contentType"];
  redirectCount: number;
}

interface ScannedMetadata {
  title?: string;
  description?: string;
  canonicalHref?: string;
  baseHref?: string;
  iconCandidates: Array<{ href: string; priority: number; order: number }>;
  openGraph: Map<string, string>;
  anchorHrefs: string[];
}

interface ParsedTag {
  name: string;
  closing: boolean;
  attributes: Map<string, string>;
}

const ENTITY_NAMES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]{1,6})|#([0-9]{1,7})|([a-z][a-z0-9]+));/giu,
    (entity, hexadecimal: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (hexadecimal || decimal) {
        const codePoint = Number.parseInt(hexadecimal ?? decimal ?? "", hexadecimal ? 16 : 10);
        if (
          !Number.isInteger(codePoint) ||
          codePoint <= 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return "\uFFFD";
        }
        return String.fromCodePoint(codePoint);
      }
      return ENTITY_NAMES[name?.toLowerCase() ?? ""] ?? entity;
    },
  );
}

export function sanitizeMetadataText(
  value: string | undefined,
  maximumCharacters: number,
): string | undefined {
  if (!value) return undefined;
  const bounded = value.slice(0, Math.max(maximumCharacters * 8, maximumCharacters));
  const sanitized = decodeHtmlEntities(bounded.replace(/<[^>]*>/gu, " "))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC")
    .slice(0, maximumCharacters)
    .trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | undefined;
  const limit = Math.min(html.length, start + MAX_TAG_CHARACTERS);

  for (let cursor = start; cursor < limit; cursor += 1) {
    const character = html[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return cursor;
    }
  }
  return -1;
}

function parseTag(source: string): ParsedTag | undefined {
  let cursor = 0;
  while (/\s/u.test(source[cursor] ?? "")) cursor += 1;

  let closing = false;
  if (source[cursor] === "/") {
    closing = true;
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  }

  const nameStart = cursor;
  while (/[a-z0-9:-]/iu.test(source[cursor] ?? "")) cursor += 1;
  if (cursor === nameStart) return undefined;
  const name = source.slice(nameStart, cursor).toLowerCase();
  const attributes = new Map<string, string>();

  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "") || source[cursor] === "/") {
      cursor += 1;
    }
    if (cursor >= source.length) break;

    const attributeStart = cursor;
    while (!/[\s=/>]/u.test(source[cursor] ?? ">")) cursor += 1;
    if (cursor === attributeStart) {
      cursor += 1;
      continue;
    }
    const attributeName = source.slice(attributeStart, cursor).toLowerCase();
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;

    let attributeValue = "";
    if (source[cursor] === "=") {
      cursor += 1;
      while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < source.length && source[cursor] !== quote) cursor += 1;
        attributeValue = source.slice(valueStart, cursor);
        if (source[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (!/[\s>]/u.test(source[cursor] ?? ">")) cursor += 1;
        attributeValue = source.slice(valueStart, cursor);
      }
    }

    if (!attributes.has(attributeName)) {
      attributes.set(attributeName, attributeValue);
    }
  }

  return { name, closing, attributes };
}

function iconPriority(relTokens: Set<string>): number | undefined {
  if (relTokens.has("icon")) return 0;
  if (relTokens.has("apple-touch-icon")) return 1;
  if (relTokens.has("mask-icon")) return 2;
  return undefined;
}

function scanMetadata(html: string): ScannedMetadata {
  const scanned: ScannedMetadata = {
    iconCandidates: [],
    openGraph: new Map(),
    anchorHrefs: [],
  };
  const lowerHtml = html.toLowerCase();
  let cursor = 0;
  let tagOrder = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) break;

    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(html, tagStart + 1);
    if (tagEnd < 0) {
      cursor = tagStart + 1;
      continue;
    }

    const tag = parseTag(html.slice(tagStart + 1, tagEnd));
    cursor = tagEnd + 1;
    if (!tag || tag.closing) continue;
    tagOrder += 1;

    if (tag.name === "title") {
      const closingStart = lowerHtml.indexOf("</title", cursor);
      if (closingStart >= 0) {
        scanned.title ??= html.slice(cursor, closingStart);
        const closingEnd = findTagEnd(html, closingStart + 1);
        cursor = closingEnd < 0 ? closingStart + 7 : closingEnd + 1;
      }
      continue;
    }

    if (
      tag.name === "script" ||
      tag.name === "style" ||
      tag.name === "template" ||
      tag.name === "noscript"
    ) {
      const closingStart = lowerHtml.indexOf(`</${tag.name}`, cursor);
      if (closingStart < 0) break;
      const closingEnd = findTagEnd(html, closingStart + 1);
      cursor = closingEnd < 0 ? html.length : closingEnd + 1;
      continue;
    }

    if (tag.name === "base") {
      scanned.baseHref ??= tag.attributes.get("href");
      continue;
    }

    if (tag.name === "meta") {
      const key = (
        tag.attributes.get("property") ??
        tag.attributes.get("name") ??
        ""
      );
      const normalizedKey = decodeHtmlEntities(key).trim().toLowerCase();
      const content = tag.attributes.get("content");
      if (!content) continue;
      if (normalizedKey === "description") scanned.description ??= content;
      if (
        normalizedKey.startsWith("og:") &&
        !scanned.openGraph.has(normalizedKey)
      ) {
        scanned.openGraph.set(normalizedKey, content);
      }
      continue;
    }

    if (tag.name === "link") {
      const href = tag.attributes.get("href");
      if (!href) continue;
      const relTokens = new Set(
        decodeHtmlEntities(tag.attributes.get("rel") ?? "")
          .toLowerCase()
          .split(/\s+/u)
          .filter(Boolean),
      );
      if (relTokens.has("canonical")) scanned.canonicalHref ??= href;
      const priority = iconPriority(relTokens);
      if (priority !== undefined) {
        scanned.iconCandidates.push({ href, priority, order: tagOrder });
      }
      continue;
    }

    if (
      tag.name === "a" &&
      scanned.anchorHrefs.length < MAX_ANCHORS_TO_INSPECT
    ) {
      const href = tag.attributes.get("href");
      if (href) scanned.anchorHrefs.push(href);
    }
  }

  return scanned;
}

function resolveMetadataUrl(value: string | undefined, base: URL): string | undefined {
  if (!value || value.length > MAX_URL_CHARACTERS) return undefined;
  try {
    const url = new URL(decodeHtmlEntities(value).trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username.length > 0 || url.password.length > 0) return undefined;
    if (hasSecretLikeQueryParameter(url)) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function effectiveBaseUrl(pageUrl: URL, baseHref: string | undefined): URL {
  const resolved = resolveMetadataUrl(baseHref, pageUrl);
  return resolved ? new URL(resolved) : pageUrl;
}

function extractGithubRepositories(
  hrefs: readonly string[],
  base: URL,
): GitHubRepositoryAnchor[] {
  const repositories: GitHubRepositoryAnchor[] = [];
  const seen = new Set<string>();

  for (const href of hrefs) {
    if (repositories.length >= MAX_GITHUB_REPOSITORIES) break;
    const absoluteUrl = resolveMetadataUrl(href, base);
    if (!absoluteUrl) continue;
    const normalized = normalizeProjectUrl(absoluteUrl);
    if (
      !normalized.ok ||
      normalized.link.kind !== "github_repo" ||
      !normalized.link.githubRepoKey ||
      seen.has(normalized.link.githubRepoKey)
    ) {
      continue;
    }

    seen.add(normalized.link.githubRepoKey);
    repositories.push({
      repoKey: normalized.link.githubRepoKey,
      url: `https://github.com/${normalized.link.githubRepoKey}`,
    });
  }

  return repositories;
}

/** Extract a small deterministic metadata model without executing page code. */
export function extractWebsiteMetadata(
  html: string,
  pageUrl: string,
): ExtractedWebsiteMetadata {
  const parsedPageUrl = new URL(pageUrl);
  if (
    (parsedPageUrl.protocol !== "http:" && parsedPageUrl.protocol !== "https:") ||
    parsedPageUrl.username.length > 0 ||
    parsedPageUrl.password.length > 0
  ) {
    throw new TypeError("pageUrl must be a credential-free HTTP(S) URL");
  }

  const scanned = scanMetadata(html);
  const base = effectiveBaseUrl(parsedPageUrl, scanned.baseHref);
  const icon = [...scanned.iconCandidates].sort(
    (left, right) => left.priority - right.priority || left.order - right.order,
  )[0];

  const ogTitle = sanitizeMetadataText(scanned.openGraph.get("og:title"), 300);
  const ogDescription = sanitizeMetadataText(
    scanned.openGraph.get("og:description"),
    2_000,
  );
  const openGraph: OpenGraphMetadata = {};
  if (ogTitle) openGraph.title = ogTitle;
  if (ogDescription) openGraph.description = ogDescription;

  const ogImage =
    scanned.openGraph.get("og:image:secure_url") ??
    scanned.openGraph.get("og:image") ??
    scanned.openGraph.get("og:image:url");
  const imageUrl = resolveMetadataUrl(ogImage, base);
  const ogUrl = resolveMetadataUrl(scanned.openGraph.get("og:url"), base);
  const siteName = sanitizeMetadataText(
    scanned.openGraph.get("og:site_name"),
    300,
  );
  const type = sanitizeMetadataText(scanned.openGraph.get("og:type"), 100);
  if (imageUrl) openGraph.imageUrl = imageUrl;
  if (ogUrl) openGraph.url = ogUrl;
  if (siteName) openGraph.siteName = siteName;
  if (type) openGraph.type = type;

  const documentTitle = sanitizeMetadataText(scanned.title, 300);
  const metaDescription = sanitizeMetadataText(scanned.description, 2_000);
  return {
    title: documentTitle ?? ogTitle,
    description: metaDescription ?? ogDescription,
    canonicalUrl: resolveMetadataUrl(scanned.canonicalHref, base),
    iconUrl: resolveMetadataUrl(icon?.href, base),
    openGraph,
    githubRepositories: extractGithubRepositories(scanned.anchorHrefs, base),
  };
}

export async function fetchWebsiteMetadata(
  requestedUrl: string,
  options: SafeFetchOptions = {},
): Promise<WebsiteMetadata> {
  const fetched = await safeFetchHtml(requestedUrl, options);
  const metadata = extractWebsiteMetadata(fetched.html, fetched.finalUrl);
  return {
    requestedUrl: fetched.requestedUrl,
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    contentType: fetched.contentType,
    redirectCount: fetched.redirectCount,
    ...metadata,
  };
}
