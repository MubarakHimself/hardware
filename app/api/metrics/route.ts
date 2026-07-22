import { protectedMetrics } from "@/lib/server/metrics";
import { withApiHandler } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    const body = await protectedMetrics(request);
    return new Response(body, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "x-content-type-options": "nosniff",
        "x-correlation-id": correlationId,
      },
    });
  });
}
