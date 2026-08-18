import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import { channelUpdateSchema, updateChannelSettings } from "@/lib/server/channels";
import {
  readJsonBody,
  requireSameOrigin,
  successResponse,
  withApiHandler,
} from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.uuid();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("channels:manage");
    enforceRateLimit({
      actorId: actor.userId,
      bucket: "channels:update",
      maximum: 30,
      windowMs: 60_000,
    });
    const { id } = await context.params;
    const input = channelUpdateSchema.parse(await readJsonBody(request));
    return successResponse(
      await updateChannelSettings({
        actor,
        channelId: idSchema.parse(id),
        input,
        correlationId,
      }),
      { correlationId },
    );
  });
}
