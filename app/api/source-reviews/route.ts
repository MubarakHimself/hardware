import { requireRequestCapability } from "@/lib/server/auth";
import { successResponse, withApiHandler } from "@/lib/server/http";
import {
  listSourceReviews,
  sourceReviewQuerySchema,
} from "@/lib/server/source-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    await requireRequestCapability("channels:manage");
    const url = new URL(request.url);
    const input = sourceReviewQuerySchema.parse({
      state: url.searchParams.get("state") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    return successResponse(await listSourceReviews(input), { correlationId });
  });
}
