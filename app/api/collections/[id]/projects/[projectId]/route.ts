import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import { mutateCollectionMembership } from "@/lib/server/collections";
import {
  requireSameOrigin,
  successResponse,
  withApiHandler,
} from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const collectionIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const projectIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
type Context = { params: Promise<{ id: string; projectId: string }> };

async function mutate(request: Request, context: Context, operation: "add" | "remove") {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("collections:manage-own");
    enforceRateLimit({
      actorId: actor.userId,
      bucket: "collections:membership",
      maximum: 120,
      windowMs: 60_000,
    });
    const params = await context.params;
    const result = await mutateCollectionMembership({
      actor,
      collectionId: collectionIdSchema.parse(params.id),
      projectId: projectIdSchema.parse(params.projectId),
      operation,
      correlationId,
    });
    return successResponse(result, { correlationId });
  });
}

export function PUT(request: Request, context: Context) {
  return mutate(request, context, "add");
}

export function DELETE(request: Request, context: Context) {
  return mutate(request, context, "remove");
}
