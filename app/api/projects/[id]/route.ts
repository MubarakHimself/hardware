import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import { getProjectDetail } from "@/lib/server/catalog";
import { successResponse, withApiHandler } from "@/lib/server/http";
import { readJsonBody, requireSameOrigin } from "@/lib/server/http";
import { patchProject, projectPatchSchema } from "@/lib/server/project-mutations";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const identifierSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiHandler(request, async ({ correlationId }) => {
    const actor = await requireRequestCapability("catalog:read");
    const { id } = await context.params;
    const project = await getProjectDetail(actor, identifierSchema.parse(id));
    return successResponse(project, { correlationId });
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("projects:edit");
    enforceRateLimit({ actorId: actor.userId, bucket: "projects:edit", maximum: 60, windowMs: 60_000 });
    const { id } = await context.params;
    const input = projectPatchSchema.parse(await readJsonBody(request));
    const project = await patchProject({ actor, projectId: identifierSchema.parse(id), input, correlationId });
    return successResponse(project, { correlationId });
  });
}
