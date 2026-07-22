import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import {
  deleteCollection,
  updateCollection,
  updateCollectionSchema,
} from "@/lib/server/collections";
import {
  readJsonBody,
  requireSameOrigin,
  successResponse,
  withApiHandler,
} from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { ApiError } from "@/lib/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("collections:manage-own");
    enforceRateLimit({ actorId: actor.userId, bucket: "collections:update", maximum: 60, windowMs: 60_000 });
    const { id } = await context.params;
    const input = updateCollectionSchema.parse(await readJsonBody(request));
    return successResponse(
      await updateCollection({ actor, collectionId: idSchema.parse(id), input, correlationId }),
      { correlationId },
    );
  });
}

export async function DELETE(request: Request, context: Context) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("collections:manage-own");
    enforceRateLimit({ actorId: actor.userId, bucket: "collections:delete", maximum: 20, windowMs: 60_000 });
    const ifMatch = request.headers.get("if-match")?.replace(/^W\//, "").replaceAll('"', "");
    const version = z.coerce.number().int().positive().safeParse(ifMatch);
    if (!version.success) {
      throw new ApiError({ status: 428, code: "precondition_required", title: "Precondition required", detail: "Supply the collection version in the If-Match header." });
    }
    const { id } = await context.params;
    return successResponse(
      await deleteCollection({ actor, collectionId: idSchema.parse(id), version: version.data, correlationId }),
      { correlationId },
    );
  });
}
