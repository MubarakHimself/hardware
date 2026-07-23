import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import {
  readJsonBody,
  requireSameOrigin,
  successResponse,
  withApiHandler,
} from "@/lib/server/http";
import {
  sourceReviewUpdateSchema,
  updateSourceReview,
} from "@/lib/server/source-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("channels:manage");
    const { id } = await context.params;
    const reviewId = z.uuid().parse(id);
    const input = sourceReviewUpdateSchema.parse(await readJsonBody(request));
    return successResponse(
      await updateSourceReview({
        actor,
        reviewId,
        state: input.state,
        note: input.note,
        expectedIssueFingerprint: input.expectedIssueFingerprint,
        expectedVersion: input.expectedVersion,
        correlationId,
      }),
      { correlationId },
    );
  });
}
