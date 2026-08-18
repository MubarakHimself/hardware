import { successResponse, withApiHandler } from "@/lib/server/http";
import { desktopRuntimeReadiness } from "@/lib/server/runtime-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) =>
    successResponse(await desktopRuntimeReadiness(request), { correlationId }),
  );
}
