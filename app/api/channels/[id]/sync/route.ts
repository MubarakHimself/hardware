import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import { syncChannel } from "@/lib/server/channels";
import { requireSameOrigin, successResponse, withApiHandler } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("channels:manage");
    enforceRateLimit({ actorId: actor.userId, bucket: "channels:sync", maximum: 30, windowMs: 60_000 });
    const { id } = await context.params;
    const result = await syncChannel({ actor, channelId: idSchema.parse(id), correlationId });
    return successResponse(result, { status: result.created ? 202 : 200, correlationId });
  });
}
