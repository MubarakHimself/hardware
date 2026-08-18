import { z } from "zod";
import {
  readJsonBody,
  successResponse,
  withApiHandler,
} from "@/lib/server/http";
import {
  isRuntimeDraining,
  requireDesktopRuntimeToken,
  setRuntimeDraining,
} from "@/lib/server/runtime-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const drainSchema = z.object({ draining: z.boolean() }).strict();

export async function GET(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireDesktopRuntimeToken(request);
    return successResponse(
      { draining: isRuntimeDraining() },
      { correlationId },
    );
  });
}

export async function POST(request: Request) {
  return withApiHandler(request, async ({ correlationId }) => {
    requireDesktopRuntimeToken(request);
    const input = drainSchema.parse(await readJsonBody(request));
    return successResponse(setRuntimeDraining(input.draining), {
      correlationId,
    });
  });
}
