export const YOUTUBE_DESCRIPTION_PARSER_VERSION =
  "youtube-description/v1" as const;

export type ParserDiagnosticSeverity = "warning" | "error";

export type ParserDiagnosticCode =
  | "ALL_URLS_INVALID"
  | "DESCRIPTION_TOO_LARGE"
  | "DUPLICATE_LINK"
  | "EMPTY_DESCRIPTION"
  | "INVALID_URL"
  | "LABEL_INFERRED_FROM_URL"
  | "MALFORMED_TIMESTAMP"
  | "MULTIPLE_URLS"
  | "NON_MONOTONIC_TIMESTAMP"
  | "SENSITIVE_QUERY"
  | "TIMESTAMP_OUT_OF_RANGE"
  | "UNRESOLVABLE_YOUTUBE_REDIRECT"
  | "UNSUPPORTED_PROTOCOL"
  | "URL_HAS_CREDENTIALS"
  | "YOUTUBE_INTERNAL";

export interface ParserDiagnostic {
  code: ParserDiagnosticCode;
  severity: ParserDiagnosticSeverity;
  message: string;
  line?: number;
  column?: number;
  raw?: string;
}

export type ParsedLinkKind = "github_repo" | "website";

export interface ParsedLink {
  /** Exact URL token as written in the source description. */
  rawUrl: string;
  /** Direct destination after supported YouTube redirects are unwrapped. */
  resolvedUrl: string;
  /** Conservative identity form used for exact matching. */
  canonicalUrl: string;
  kind: ParsedLinkKind;
  githubRepoKey?: string;
  inferredScheme: boolean;
}

export interface ParsedProjectMention {
  /** Source order. Mentions are never silently re-sorted by timestamp. */
  ordinal: number;
  timestampText: string;
  timestampSeconds: number;
  name: string;
  links: ParsedLink[];
  primaryLinkIndex: 0;
  sourceLineStart: number;
  sourceLineEnd: number;
  sourceOffsetStart: number;
  sourceOffsetEnd: number;
  /** Exact source substring used to produce this mention. */
  rawSegment: string;
  warnings: ParserDiagnostic[];
}

export type RejectedTimestampReason =
  | "NO_EXTERNAL_URL"
  | "ALL_URLS_INVALID";

export interface RejectedTimestampRow {
  timestampText: string;
  timestampSeconds: number;
  sourceLineStart: number;
  sourceLineEnd: number;
  rawSegment: string;
  reason: RejectedTimestampReason;
}

export type IgnoredLinkReason =
  | "UNSCOPED_URL"
  | "YOUTUBE_INTERNAL"
  | "INVALID_URL";

export interface IgnoredLink {
  rawUrl: string;
  line: number;
  column: number;
  reason: IgnoredLinkReason;
}

export interface ParseDescriptionInput {
  videoId: string;
  description: string | null | undefined;
  durationSeconds?: number;
}

export interface ParseDescriptionResult {
  parserVersion: typeof YOUTUBE_DESCRIPTION_PARSER_VERSION;
  mentions: ParsedProjectMention[];
  rejectedRows: RejectedTimestampRow[];
  ignoredLinks: IgnoredLink[];
  diagnostics: ParserDiagnostic[];
}

export type NormalizeProjectUrlResult =
  | { ok: true; link: ParsedLink }
  | {
      ok: false;
      code:
        | "INVALID_URL"
        | "SENSITIVE_QUERY"
        | "UNRESOLVABLE_YOUTUBE_REDIRECT"
        | "UNSUPPORTED_PROTOCOL"
        | "URL_HAS_CREDENTIALS"
        | "YOUTUBE_INTERNAL";
      message: string;
    };
