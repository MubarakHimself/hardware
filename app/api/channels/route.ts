import { requireRequestCapability } from "@/lib/server/auth";
import { addChannel, channelCreateSchema, listChannels } from "@/lib/server/channels";
import { readJsonBody, requireSameOrigin, successResponse, withApiHandler } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    await requireRequestCapability("channels:manage");
    return successResponse(await listChannels(), { correlationId });
  });
}

export async function POST(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("channels:manage");
    enforceRateLimit({ actorId: actor.userId, bucket: "channels:create", maximum: 10, windowMs: 60_000 });
    const input = channelCreateSchema.parse(await readJsonBody(request));
    const result = await addChannel({ actor, input, correlationId });
    return successResponse(result, { status: result.created ? 202 : 200, correlationId });
  });
}
