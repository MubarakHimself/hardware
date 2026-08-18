import { requireRequestCapability } from "@/lib/server/auth";
import { listAuditEvents, auditEventQuerySchema } from "@/lib/server/audit-events";
import { successResponse, withApiHandler } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    const actor = await requireRequestCapability("catalog:read");
    const url = new URL(request.url);
    const query = auditEventQuerySchema.parse({
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    return successResponse(
      await listAuditEvents({
        actor,
        limit: query.limit,
        cursor: query.cursor,
      }),
      { correlationId },
    );
  });
}
