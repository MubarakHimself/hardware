import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import { getImportBatch } from "@/lib/server/import-batches";
import { successResponse, withApiHandler } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiHandler(request, async ({ correlationId }) => {
    const actor = await requireRequestCapability("imports:create");
    const { id } = await context.params;
    const batch = await getImportBatch({ actor, batchId: z.uuid().parse(id) });
    return successResponse(batch, { correlationId });
  });
}
