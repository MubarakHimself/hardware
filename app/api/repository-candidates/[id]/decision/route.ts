import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import {
  readJsonBody,
  requireSameOrigin,
  successResponse,
  withApiHandler,
} from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import {
  decideRepositoryCandidate,
  repositoryDecisionSchema,
} from "@/lib/server/repository-candidates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const candidateIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("repository-candidates:decide");
    enforceRateLimit({
      actorId: actor.userId,
      bucket: "repository-candidates:decide",
      maximum: 60,
      windowMs: 60_000,
    });
    const { id } = await context.params;
    const decision = repositoryDecisionSchema.parse(await readJsonBody(request));
    const result = await decideRepositoryCandidate({
      actor,
      candidateId: candidateIdSchema.parse(id),
      decision,
      correlationId,
    });
    return successResponse(result, { correlationId });
  });
}
