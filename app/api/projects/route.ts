import { listProjects } from "@/lib/server/catalog";
import { requireRequestCapability } from "@/lib/server/auth";
import { successResponse, withApiHandler } from "@/lib/server/http";
import { parseProjectQuery } from "@/lib/validation";
import { measureSearchOperation } from "@/lib/observability/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    const actor = await requireRequestCapability("catalog:read");
    const query = parseProjectQuery(new URL(request.url).searchParams);
    const page = await measureSearchOperation(() => listProjects(actor, query));
    return successResponse(page.projects, {
      correlationId,
      meta: {
        nextCursor: page.nextCursor,
        limit: query.limit,
        facets: page.facets,
      },
    });
  });
}
