import "server-only";
import { z } from "zod";
import { getPool } from "../../db/index";
import type { AuthenticatedActor } from "../domain";
import { getServerConfig } from "./config";
import { unprocessable } from "./errors";

export const auditEventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(75),
  cursor: z.string().trim().min(1).max(512).optional(),
});

export interface AuditEventDto {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  status: "succeeded" | "failed" | "info";
  beforeRelease: string | null;
  afterRelease: string | null;
  createdAt: string;
}

export interface AuditEventPage {
  items: AuditEventDto[];
  nextCursor: string | null;
  totalCount: number;
}

const auditCursorSchema = z
  .object({
    createdAt: z.iso.datetime(),
    id: z.string().regex(/^\d+$/u),
  })
  .strict();

type AuditCursor = z.infer<typeof auditCursorSchema>;

function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAuditCursor(cursor?: string): AuditCursor | null {
  if (!cursor) return null;
  try {
    return auditCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch {
    throw unprocessable(
      "invalid_cursor",
      "The audit pagination cursor is invalid or expired.",
    );
  }
}

function safeRelease(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : null;
}

function dto(row: Record<string, unknown>): AuditEventDto {
  const rawStatus = String(row.status ?? "");
  return {
    id: String(row.id),
    action: String(row.action),
    targetType: String(row.targetType),
    targetId: String(row.targetId),
    status:
      rawStatus === "succeeded" || rawStatus === "failed"
        ? rawStatus
        : "info",
    beforeRelease: safeRelease(row.beforeRelease),
    afterRelease: safeRelease(row.afterRelease),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
  };
}

export async function listAuditEvents(options: {
  actor: AuthenticatedActor;
  limit: number;
  cursor?: string;
}): Promise<AuditEventPage> {
  if (getServerConfig().mode === "demo") {
    return { items: [], nextCursor: null, totalCount: 0 };
  }
  const cursor = decodeAuditCursor(options.cursor);
  const result = await getPool().query(
    `with visible_events as (
       select id, action, target_type, target_id, after_summary, created_at,
              count(*) over ()::int as "totalCount"
         from audit_events
        where actor_user_id = $1::uuid or actor_user_id is null
     )
     select id::text, action, target_type as "targetType",
            target_id as "targetId", after_summary ->> 'status' as status,
            after_summary ->> 'beforeRelease' as "beforeRelease",
            after_summary ->> 'afterRelease' as "afterRelease",
            created_at as "createdAt", "totalCount"
       from visible_events
      where ($2::timestamptz is null or created_at < $2::timestamptz
             or (created_at = $2::timestamptz and id < $3::bigint))
      order by created_at desc, id desc
      limit $4`,
    [
      options.actor.userId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      options.limit + 1,
    ],
  );
  const hasNext = result.rows.length > options.limit;
  const visibleRows = result.rows.slice(0, options.limit);
  const last = visibleRows.at(-1);
  return {
    items: visibleRows.map(dto),
    nextCursor:
      hasNext && last
        ? encodeAuditCursor({
            createdAt:
              last.createdAt instanceof Date
                ? last.createdAt.toISOString()
                : String(last.createdAt),
            id: String(last.id),
          })
        : null,
    totalCount: Number(result.rows[0]?.totalCount ?? 0),
  };
}
