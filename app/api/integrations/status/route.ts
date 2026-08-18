import { requireRequestCapability } from "@/lib/server/auth";
import { successResponse, withApiHandler } from "@/lib/server/http";
import { listProviderStatuses } from "@/lib/server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    await requireRequestCapability("catalog:read");
    return successResponse(listProviderStatuses(), { correlationId });
  });
}
