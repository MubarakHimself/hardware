import { successResponse, withApiHandler } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) =>
    successResponse(
      {
        status: "alive",
        service: "hardware-web",
        release: process.env.RELEASE_SHA ?? "development",
      },
      { correlationId },
    ),
  );
}
