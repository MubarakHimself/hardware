import { readiness } from "@/lib/server/health";
import { successResponse, withApiHandler } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) =>
    successResponse(await readiness(request), { correlationId }),
  );
}
