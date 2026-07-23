import type { ImportCommand } from "../domain";
import { normalizeProjectUrl } from "../ingestion";
import { importRequestSchema } from "./imports";
import {
  getYouTubeChannelImportIdentity,
  getYouTubeVideoId,
  isSafeImportUrlSyntax,
} from "./public-url";
import { z } from "zod";

export const MAX_IMPORT_BATCH_ITEMS = 500;

export const importBatchRequestSchema = z
  .object({
    items: z.array(z.unknown()).min(1).max(MAX_IMPORT_BATCH_ITEMS),
  })
  .strict();

export type ValidatedBatchItem = {
  ordinal: number;
  kind: string | null;
  originalUrl: string | null;
  normalizedUrl: string | null;
  input: ImportCommand | null;
  duplicateOfOrdinal: number | null;
  validationCode: string | null;
  validationSummary: string | null;
};

function normalizedImportUrl(input: ImportCommand): string {
  if (input.kind === "youtube_video") {
    const videoId = getYouTubeVideoId(input.url);
    if (!videoId) throw new Error("A validated YouTube URL has no video identity.");
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  if (input.kind === "youtube_channel") {
    const channel = getYouTubeChannelImportIdentity(input.url);
    if (!channel) throw new Error("A validated YouTube channel URL has no identity.");
    return channel.canonicalUrl;
  }
  const normalized = normalizeProjectUrl(input.url);
  if (!normalized.ok) throw new Error("A validated import URL failed normalization.");
  return normalized.link.canonicalUrl;
}

function rawFields(value: unknown): { kind: string | null; url: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: null, url: null };
  }
  const record = value as Record<string, unknown>;
  return {
    kind: typeof record.kind === "string" ? record.kind.slice(0, 40) : null,
    url: typeof record.url === "string" ? record.url.trim().slice(0, 2_048) : null,
  };
}

/** Validate every row independently so one malformed URL never rejects its siblings. */
export function validateImportBatchItems(items: unknown[]): ValidatedBatchItem[] {
  const firstOrdinalByIdentity = new Map<string, number>();
  return items.map((value, index) => {
    const ordinal = index + 1;
    const raw = rawFields(value);
    const parsed = importRequestSchema.safeParse(value);
    if (!parsed.success) {
      return {
        ordinal,
        kind: raw.kind,
        originalUrl:
          raw.url && isSafeImportUrlSyntax(raw.url) ? raw.url : null,
        normalizedUrl: null,
        input: null,
        duplicateOfOrdinal: null,
        validationCode: "INVALID_IMPORT_ITEM",
        validationSummary:
          parsed.error.issues[0]?.message.slice(0, 500) ??
          "The import item is invalid.",
      };
    }
    const normalizedUrl = normalizedImportUrl(parsed.data);
    const identity = `${parsed.data.kind}\u0000${normalizedUrl}`;
    const duplicateOfOrdinal = firstOrdinalByIdentity.get(identity) ?? null;
    if (duplicateOfOrdinal === null) firstOrdinalByIdentity.set(identity, ordinal);
    return {
      ordinal,
      kind: parsed.data.kind,
      originalUrl: parsed.data.url,
      normalizedUrl,
      input: parsed.data,
      duplicateOfOrdinal,
      validationCode: null,
      validationSummary: null,
    };
  });
}
