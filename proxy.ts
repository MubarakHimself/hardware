import { NextResponse, type NextRequest } from "next/server";
import { getServerConfig } from "./lib/server/config";
import { isAllowedLocalHost } from "./lib/server/local-request";
import { isAuthorizedProbeRequest } from "./lib/server/probe-auth";

export default function proxy(request: NextRequest) {
  const config = getServerConfig();
  if (!isAllowedLocalHost(request.headers.get("host"), config.appOrigin)) {
    return new NextResponse("Forbidden", {
      status: 403,
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (
    config.mode === "local" &&
    config.desktopSessionToken &&
    !isAuthorizedProbeRequest(request, config.desktopSessionToken)
  ) {
    return new NextResponse("Unauthorized", {
      status: 401,
      headers: {
        "cache-control": "private, no-store",
        "www-authenticate": "Bearer",
      },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|txt|xml|woff2?)).*)",
  ],
};
