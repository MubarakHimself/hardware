import { handleClerkWebhook } from "@/lib/server/clerk-webhook";
import { successResponse, withApiHandler } from "@/lib/server/http";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return withApiHandler(request, async ({ correlationId }) =>
    successResponse(await handleClerkWebhook(request, correlationId), {
      correlationId,
    }),
  );
}
