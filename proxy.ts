import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { getServerConfig } from "./lib/server/config";

const clerkProxy = clerkMiddleware(async (auth, request) => {
  // API handlers enforce authorization themselves so they can return the
  // product's RFC 9457 response contract. Middleware still establishes Clerk
  // request context for auth().
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }
  await auth.protect();
  return NextResponse.next();
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (
    request.nextUrl.pathname === "/api/health/live" ||
    request.nextUrl.pathname === "/api/health/ready" ||
    request.nextUrl.pathname === "/api/metrics"
  ) {
    return NextResponse.next();
  }
  const config = getServerConfig();
  if (config.mode === "demo") return NextResponse.next();
  return clerkProxy(request, event);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|txt|xml|woff2?)).*)",
  ],
};
