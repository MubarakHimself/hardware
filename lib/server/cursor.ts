import "server-only";
import { z } from "zod";
import { unprocessable } from "./errors";

const cursorPayloadSchema = z.object({ offset: z.number().int().min(0).max(1_000_000) });

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeOffsetCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return cursorPayloadSchema.parse(payload).offset;
  } catch {
    throw unprocessable("invalid_cursor", "The pagination cursor is invalid or expired.");
  }
}
