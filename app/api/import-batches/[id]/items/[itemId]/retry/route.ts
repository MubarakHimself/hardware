import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import { retryImportBatchItem } from "@/lib/server/import-batches";
import {
  requireSameOrigin,
  successResponse,
  withApiHandler,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; itemId: string }> },
) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("imports:create");
    const params = await context.params;
    return successResponse(
      await retryImportBatchItem({
        actor,
        batchId: z.uuid().parse(params.id),
        itemId: z.uuid().parse(params.itemId),
        correlationId,
      }),
      { status: 202, correlationId },
    );
  });
}
