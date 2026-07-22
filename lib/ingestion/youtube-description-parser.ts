import {
  extractUrlTokens,
  normalizeProjectUrl,
  type ExtractedUrlToken,
} from "./url";
import {
  YOUTUBE_DESCRIPTION_PARSER_VERSION,
  type IgnoredLink,
  type ParseDescriptionInput,
  type ParseDescriptionResult,
  type ParsedLink,
  type ParsedProjectMention,
  type ParserDiagnostic,
  type RejectedTimestampRow,
} from "./types";

export const MAX_DESCRIPTION_CHARACTERS = 100_000;

const TIMESTAMP_HEADER_PATTERN =
  /^\s*(?:[-*•·]\s*)?(?:\[(\d{1,3}:\d{2}(?::\d{2})?)\]|(\d{1,3}:\d{2}(?::\d{2})?))(?=\s|[-–—|:])\s*(?:[-–—|:]\s*)?(.*)$/u;

const TIMESTAMP_LIKE_PATTERN =
  /^\s*(?:[-*•·]\s*)?\[?\d{1,3}:\d{1,2}(?::\d{1,2})?\]?/u;

interface SourceLine {
  index: number;
  number: number;
  content: string;
  start: number;
  end: number;
}

interface TimestampHeader {
  line: SourceLine;
  timestampText: string;
  timestampSeconds: number;
  tail: string;
  tailStart: number;
}

interface LocatedUrlToken extends ExtractedUrlToken {
  line: SourceLine;
  column: number;
}

function emptyResult(): ParseDescriptionResult {
  return {
    parserVersion: YOUTUBE_DESCRIPTION_PARSER_VERSION,
    mentions: [],
    rejectedRows: [],
    ignoredLinks: [],
    diagnostics: [],
  };
}

function splitSourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let lineStart = 0;
  let lineIndex = 0;

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character !== "\r" && character !== "\n") {
      continue;
    }

    lines.push({
      index: lineIndex,
      number: lineIndex + 1,
      content: source.slice(lineStart, cursor),
      start: lineStart,
      end: cursor,
    });
    lineIndex += 1;

    if (character === "\r" && source[cursor + 1] === "\n") {
      cursor += 1;
    }
    lineStart = cursor + 1;
  }

  lines.push({
    index: lineIndex,
    number: lineIndex + 1,
    content: source.slice(lineStart),
    start: lineStart,
    end: source.length,
  });

  return lines;
}

export function timestampToSeconds(timestampText: string): number | undefined {
  const components = timestampText.split(":").map(Number);
  if (
    (components.length !== 2 && components.length !== 3) ||
    components.some((component) => !Number.isSafeInteger(component) || component < 0)
  ) {
    return undefined;
  }

  if (components.length === 2) {
    const [minutes, seconds] = components;
    if (seconds >= 60) return undefined;
    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = components;
  if (minutes >= 60 || seconds >= 60) return undefined;
  return hours * 3_600 + minutes * 60 + seconds;
}

function parseTimestampHeader(line: SourceLine):
  | { kind: "valid"; header: TimestampHeader }
  | { kind: "invalid" }
  | { kind: "none" } {
  const match = line.content.match(TIMESTAMP_HEADER_PATTERN);
  if (!match) {
    return TIMESTAMP_LIKE_PATTERN.test(line.content)
      ? { kind: "invalid" }
      : { kind: "none" };
  }

  const timestampText = match[1] ?? match[2];
  const tail = match[3] ?? "";
  const timestampSeconds = timestampToSeconds(timestampText);
  if (timestampSeconds === undefined) {
    return { kind: "invalid" };
  }

  return {
    kind: "valid",
    header: {
      line,
      timestampText,
      timestampSeconds,
      tail,
      tailStart: line.content.length - tail.length,
    },
  };
}

function locateTokens(
  line: SourceLine,
  text: string,
  textStart: number,
): LocatedUrlToken[] {
  return extractUrlTokens(text).map((token) => ({
    ...token,
    start: token.start + textStart,
    end: token.end + textStart,
    line,
    column: token.start + textStart + 1,
  }));
}

function tokenKey(token: LocatedUrlToken): string {
  return `${token.line.index}:${token.start}:${token.end}`;
}

function removeTokens(text: string, tokens: ExtractedUrlToken[]): string {
  let result = text;
  const descending = [...tokens].sort((left, right) => right.start - left.start);
  for (const token of descending) {
    result = `${result.slice(0, token.start)} ${result.slice(token.end)}`;
  }
  return result;
}

function cleanProjectName(value: string): string {
  return value
    .replace(/\[\s*([^\]]+?)\s*\]\(\s*\)/gu, "$1")
    .replace(/^[\s\-–—|:]+/u, "")
    .replace(/[\s\-–—|:.,;]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC");
}

function inferredProjectName(link: ParsedLink): string {
  if (link.githubRepoKey) {
    return link.githubRepoKey.split("/")[1] ?? link.githubRepoKey;
  }

  try {
    return new URL(link.resolvedUrl).hostname.replace(/^www\./iu, "");
  } catch {
    return link.canonicalUrl;
  }
}

function diagnostic(
  code: ParserDiagnostic["code"],
  message: string,
  line: SourceLine,
  raw?: string,
  severity: ParserDiagnostic["severity"] = "warning",
): ParserDiagnostic {
  return {
    code,
    severity,
    message,
    line: line.number,
    column: 1,
    raw,
  };
}

function firstContinuationLine(
  lines: SourceLine[],
  header: TimestampHeader,
  headerKinds: Map<number, "valid" | "invalid">,
): SourceLine | undefined {
  const immediate = lines[header.line.index + 1];
  if (!immediate) return undefined;
  if (headerKinds.has(immediate.index)) return undefined;
  if (immediate.content.trim().length > 0) return immediate;

  const afterOneBlank = lines[header.line.index + 2];
  if (!afterOneBlank || afterOneBlank.content.trim().length === 0) return undefined;
  if (headerKinds.has(afterOneBlank.index)) return undefined;
  return afterOneBlank;
}

function ignoredReason(
  normalized: ReturnType<typeof normalizeProjectUrl>,
): IgnoredLink["reason"] {
  if (normalized.ok) return "UNSCOPED_URL";
  return normalized.code === "YOUTUBE_INTERNAL"
    ? "YOUTUBE_INTERNAL"
    : "INVALID_URL";
}

/** Parse timestamped project links from a raw YouTube Data API description. */
export function parseYouTubeDescription(
  input: ParseDescriptionInput,
): ParseDescriptionResult {
  const result = emptyResult();
  const source = input.description ?? "";

  if (source.length === 0) {
    result.diagnostics.push({
      code: "EMPTY_DESCRIPTION",
      severity: "warning",
      message: "The video description is empty.",
    });
    return result;
  }

  if (source.length > MAX_DESCRIPTION_CHARACTERS) {
    result.diagnostics.push({
      code: "DESCRIPTION_TOO_LARGE",
      severity: "error",
      message: `Description exceeds the ${MAX_DESCRIPTION_CHARACTERS}-character parser limit.`,
    });
    return result;
  }

  const lines = splitSourceLines(source);
  const headers: TimestampHeader[] = [];
  const headerKinds = new Map<number, "valid" | "invalid">();

  for (const line of lines) {
    const parsed = parseTimestampHeader(line);
    if (parsed.kind === "valid") {
      headers.push(parsed.header);
      headerKinds.set(line.index, "valid");
    } else if (parsed.kind === "invalid") {
      headerKinds.set(line.index, "invalid");
      result.diagnostics.push(
        diagnostic(
          "MALFORMED_TIMESTAMP",
          "Timestamp components must use M:SS or H:MM:SS with values below 60.",
          line,
          line.content,
        ),
      );
    }
  }

  const claimedTokens = new Set<string>();
  let previousTimestamp: number | undefined;

  for (const header of headers) {
    const warnings: ParserDiagnostic[] = [];
    if (
      previousTimestamp !== undefined &&
      header.timestampSeconds < previousTimestamp
    ) {
      warnings.push(
        diagnostic(
          "NON_MONOTONIC_TIMESTAMP",
          "Timestamp is earlier than the preceding timestamp row.",
          header.line,
          header.timestampText,
        ),
      );
    }
    previousTimestamp = header.timestampSeconds;

    if (
      input.durationSeconds !== undefined &&
      Number.isFinite(input.durationSeconds) &&
      input.durationSeconds >= 0 &&
      header.timestampSeconds > input.durationSeconds + 1
    ) {
      warnings.push(
        diagnostic(
          "TIMESTAMP_OUT_OF_RANGE",
          "Timestamp is beyond the known video duration.",
          header.line,
          header.timestampText,
        ),
      );
    }

    const headerTokens = locateTokens(header.line, header.tail, header.tailStart);
    let locatedTokens = headerTokens;
    let segmentEndLine = header.line;
    let labelSource = removeTokens(
      header.tail,
      headerTokens.map((token) => ({
        rawUrl: token.rawUrl,
        start: token.start - header.tailStart,
        end: token.end - header.tailStart,
      })),
    );

    if (locatedTokens.length === 0) {
      const continuation = firstContinuationLine(lines, header, headerKinds);
      if (continuation) {
        const continuationTokens = locateTokens(
          continuation,
          continuation.content,
          0,
        );
        if (continuationTokens.length > 0) {
          locatedTokens = continuationTokens;
          segmentEndLine = continuation;
          if (cleanProjectName(labelSource).length === 0) {
            labelSource = removeTokens(continuation.content, continuationTokens);
          }
        }
      }
    }

    for (const token of locatedTokens) {
      claimedTokens.add(tokenKey(token));
    }

    const links: ParsedLink[] = [];
    const linkIdentity = new Set<string>();

    for (const token of locatedTokens) {
      const normalized = normalizeProjectUrl(token.rawUrl);
      if (!normalized.ok) {
        warnings.push(
          diagnostic(
            normalized.code,
            normalized.message,
            token.line,
            token.rawUrl,
          ),
        );
        continue;
      }

      const identity = normalized.link.canonicalUrl;
      if (linkIdentity.has(identity)) {
        warnings.push(
          diagnostic(
            "DUPLICATE_LINK",
            "Duplicate canonical URL in the same timestamp row was ignored.",
            token.line,
            token.rawUrl,
          ),
        );
        continue;
      }

      linkIdentity.add(identity);
      links.push(normalized.link);
    }

    const rawSegment = source.slice(header.line.start, segmentEndLine.end);
    if (links.length === 0) {
      const reason = locatedTokens.length === 0
        ? "NO_EXTERNAL_URL"
        : "ALL_URLS_INVALID";
      const rejected: RejectedTimestampRow = {
        timestampText: header.timestampText,
        timestampSeconds: header.timestampSeconds,
        sourceLineStart: header.line.number,
        sourceLineEnd: segmentEndLine.number,
        rawSegment,
        reason,
      };
      result.rejectedRows.push(rejected);

      if (reason === "ALL_URLS_INVALID") {
        warnings.push(
          diagnostic(
            "ALL_URLS_INVALID",
            "No eligible external HTTP(S) URL remained in this timestamp row.",
            header.line,
            rawSegment,
          ),
        );
      }
      result.diagnostics.push(...warnings);
      continue;
    }

    if (links.length > 1) {
      warnings.push(
        diagnostic(
          "MULTIPLE_URLS",
          "The first eligible URL is primary; additional URLs are retained.",
          header.line,
          rawSegment,
        ),
      );
    }

    let name = cleanProjectName(labelSource);
    if (name.length === 0) {
      name = inferredProjectName(links[0]);
      warnings.push(
        diagnostic(
          "LABEL_INFERRED_FROM_URL",
          "Project name was derived deterministically from its URL.",
          header.line,
          rawSegment,
        ),
      );
    }

    const mention: ParsedProjectMention = {
      ordinal: result.mentions.length + 1,
      timestampText: header.timestampText,
      timestampSeconds: header.timestampSeconds,
      name,
      links,
      primaryLinkIndex: 0,
      sourceLineStart: header.line.number,
      sourceLineEnd: segmentEndLine.number,
      sourceOffsetStart: header.line.start,
      sourceOffsetEnd: segmentEndLine.end,
      rawSegment,
      warnings,
    };
    result.mentions.push(mention);
    result.diagnostics.push(...warnings);
  }

  for (const line of lines) {
    for (const token of locateTokens(line, line.content, 0)) {
      if (claimedTokens.has(tokenKey(token))) {
        continue;
      }

      const normalized = normalizeProjectUrl(token.rawUrl);
      result.ignoredLinks.push({
        rawUrl: token.rawUrl,
        line: line.number,
        column: token.column,
        reason: ignoredReason(normalized),
      });
    }
  }

  return result;
}
