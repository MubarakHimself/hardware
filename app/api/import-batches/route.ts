import { requireRequestCapability } from "@/lib/server/auth";
import {
  createImportBatch,
  importBatchIdempotencyKeySchema,
} from "@/lib/server/import-batches";
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
      bucket: "import-batches:create",
      maximum: 5,
      windowMs: 60_000,
    });
    const input = importBatchRequestSchema.parse(await readJsonBody(request));
    const suppliedIdempotencyKey = importBatchIdempotencyKeySchema.parse(
      request.headers.get("idempotency-key")?.trim() || undefined,
    );
    const result = await createImportBatch({
      actor,
      input,
      correlationId,
      suppliedIdempotencyKey,
    });
    return successResponse(result.batch, {
      status: result.created ? 202 : 200,
      correlationId,
      meta: { created: result.created },
    });
  });
}
