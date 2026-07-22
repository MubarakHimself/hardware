import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import {
  readJsonBody,
  requireSameOrigin,
  successResponse,
  withApiHandler,
} from "@/lib/server/http";
import { queueImport } from "@/lib/server/imports";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { importRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .optional();

export async function POST(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireSameOrigin(request);
    const actor = await requireRequestCapability("imports:create");
    enforceRateLimit({
      actorId: actor.userId,
      bucket: "imports:create",
      maximum: 10,
      windowMs: 60_000,
    });
    const input = importRequestSchema.parse(await readJsonBody(request));
    const suppliedIdempotencyKey = idempotencyKeySchema.parse(
      request.headers.get("idempotency-key")?.trim() || undefined,
    );
    const queued = await queueImport({
      actor,
      input,
      correlationId,
      suppliedIdempotencyKey,
    });
    return successResponse(queued.job, {
      status: queued.created ? 202 : 200,
      correlationId,
      meta: { created: queued.created },
    });
  });
}
