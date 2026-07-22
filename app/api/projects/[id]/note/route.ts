import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import { readJsonBody, requireSameOrigin, successResponse, withApiHandler } from "@/lib/server/http";
import { projectNoteSchema, putProjectNote } from "@/lib/server/personal-state";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("notes:manage-own");
    enforceRateLimit({ actorId: actor.userId, bucket: "notes:update", maximum: 120, windowMs: 60_000 });
    const { id } = await context.params;
    const input = projectNoteSchema.parse(await readJsonBody(request));
    return successResponse(await putProjectNote({ actor, projectId: idSchema.parse(id), input }), { correlationId });
  });
}
