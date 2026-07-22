import { requireRequestCapability } from "@/lib/server/auth";
import {
  createCollection,
  createCollectionSchema,
  listCollections,
} from "@/lib/server/collections";
import {
  readJsonBody,
  requireSameOrigin,
  successResponse,
  withApiHandler,
} from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    const actor = await requireRequestCapability("collections:read-visible");
    return successResponse(await listCollections(actor), { correlationId });
  });
}

export async function POST(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("collections:create");
    enforceRateLimit({
      actorId: actor.userId,
      bucket: "collections:create",
      maximum: 20,
      windowMs: 60_000,
    });
    const input = createCollectionSchema.parse(await readJsonBody(request));
    const collection = await createCollection(actor, input, correlationId);
    return successResponse(collection, { status: 201, correlationId });
  });
}
