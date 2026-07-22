import { requireRequestCapability } from "@/lib/server/auth";
import { successResponse, withApiHandler } from "@/lib/server/http";
import { listRepositoryCandidates } from "@/lib/server/repository-candidates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    await requireRequestCapability("repository-candidates:decide");
    return successResponse(await listRepositoryCandidates(), { correlationId });
  });
}
