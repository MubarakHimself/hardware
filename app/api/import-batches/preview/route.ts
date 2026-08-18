import { requireRequestCapability } from "@/lib/server/auth";
import { previewImportBatch } from "@/lib/server/import-batches";
import {
  readJsonBody,
  requireSameOrigin,
  successResponse,
  withApiHandler,
} from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { importBatchRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("imports:create");
    enforceRateLimit({
      actorId: actor.userId,
      bucket: "import-batches:preview",
      maximum: 20,
      windowMs: 60_000,
    });
    const input = importBatchRequestSchema.parse(await readJsonBody(request));
    return successResponse(previewImportBatch(input.items), { correlationId });
  });
}
