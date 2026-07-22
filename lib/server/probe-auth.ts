import "server-only";
import { timingSafeEqual } from "node:crypto";

export function isAuthorizedProbeRequest(
  request: Request,
  expectedSecret: string,
): boolean {
  const supplied =
    request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1] ??
    "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expectedSecret);
  return (
    suppliedBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}
