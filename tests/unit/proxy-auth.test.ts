import { NextRequest, type NextFetchEvent } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const middleware = vi.hoisted(() => ({
  protect: vi.fn(async () => undefined),
  getServerConfig: vi.fn(
    (): { mode: "production" | "demo" } => ({ mode: "production" }),
  ),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware:
    (handler: (auth: { protect: typeof middleware.protect }, request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) => handler({ protect: middleware.protect }, request),
}));

vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => middleware.getServerConfig(),
}));

import proxy from "../../proxy";

const event = {} as NextFetchEvent;

describe("production Clerk boundary", () => {
  beforeEach(() => {
    middleware.protect.mockClear();
    middleware.getServerConfig.mockClear();
    middleware.getServerConfig.mockReturnValue({ mode: "production" });
  });

  it("requires Clerk protection for every production product page", async () => {
    await proxy(new NextRequest("https://hardware.example.test/inventory"), event);
    expect(middleware.protect).toHaveBeenCalledTimes(1);
  });

  it("lets API handlers return their own RFC 9457 authorization response", async () => {
    await proxy(new NextRequest("https://hardware.example.test/api/projects"), event);
    expect(middleware.protect).not.toHaveBeenCalled();
    expect(middleware.getServerConfig).toHaveBeenCalledTimes(1);
  });

  it("does not let Clerk consume the operational Bearer token before metrics", async () => {
    await proxy(
      new NextRequest("https://hardware.example.test/api/metrics", {
        headers: { authorization: `Bearer ${"a".repeat(32)}` },
      }),
      event,
    );
    expect(middleware.protect).not.toHaveBeenCalled();
    expect(middleware.getServerConfig).not.toHaveBeenCalled();
  });

  it("bypasses Clerk only for explicit demo mode and protected health handlers", async () => {
    middleware.getServerConfig.mockReturnValue({ mode: "demo" });
    await proxy(new NextRequest("http://localhost:3000/radar"), event);
    await proxy(new NextRequest("https://hardware.example.test/api/health/ready"), event);
    expect(middleware.protect).not.toHaveBeenCalled();
  });
});
