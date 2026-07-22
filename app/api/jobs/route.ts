import { z } from "zod";
import { requireRequestCapability } from "@/lib/server/auth";
import { successResponse, withApiHandler } from "@/lib/server/http";
import { listJobs } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    const actor = await requireRequestCapability("catalog:read");
    const url = new URL(request.url);
    const query = querySchema.parse({ limit: url.searchParams.get("limit") ?? undefined });
    const jobs = await listJobs({ actor, limit: query.limit });
    return successResponse(jobs, { correlationId });
  });
}
