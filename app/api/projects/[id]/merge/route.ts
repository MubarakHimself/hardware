import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import { readJsonBody, requireSameOrigin, successResponse, withApiHandler } from "@/lib/server/http";
import { mergeProject, projectMergeSchema } from "@/lib/server/project-mutations";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("projects:merge");
    enforceRateLimit({ actorId: actor.userId, bucket: "projects:merge", maximum: 20, windowMs: 60_000 });
    const { id } = await context.params;
    const input = projectMergeSchema.parse(await readJsonBody(request));
    return successResponse(await mergeProject({ actor, sourceProjectId: idSchema.parse(id), input, correlationId }), { correlationId });
  });
}
