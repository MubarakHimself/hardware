import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import { readJsonBody, requireSameOrigin, successResponse, withApiHandler } from "@/lib/server/http";
import { projectPreferenceSchema, putProjectPreference } from "@/lib/server/personal-state";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("preferences:manage-own");
    enforceRateLimit({ actorId: actor.userId, bucket: "preferences:update", maximum: 120, windowMs: 60_000 });
    const { id } = await context.params;
    const input = projectPreferenceSchema.parse(await readJsonBody(request));
    return successResponse(await putProjectPreference({ actor, projectId: idSchema.parse(id), input }), { correlationId });
  });
}
