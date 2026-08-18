import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runtime = vi.hoisted(() => ({
  appOrigin: "http://127.0.0.1:3000",
  getServerConfig: vi.fn(),
}));

vi.mock("../../lib/server/config", () => ({
  getServerConfig: () => runtime.getServerConfig(),
}));

import proxy from "../../proxy";

function request(host: string) {
  return new NextRequest("http://127.0.0.1:3000/inventory", {
    headers: { host },
  });
}

describe("local Host boundary", () => {
  beforeEach(() => {
    runtime.getServerConfig.mockReset();
    runtime.getServerConfig.mockReturnValue({
      mode: "local",
      appOrigin: runtime.appOrigin,
    });
  });

  it("allows loopback aliases on the configured port without authentication", () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000"]) {
      expect(proxy(request(host)).status).toBe(200);
    }
  });

  it("rejects DNS-rebinding hosts and unexpected ports", () => {
    for (const host of [
      "hardware.example.test:3000",
      "127.0.0.1:3001",
      "127.0.0.1:3000@evil.example",
    ]) {
      const response = proxy(request(host));
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("does not allow an operational bearer token to bypass Host validation", () => {
    const incoming = new NextRequest("http://127.0.0.1:3000/api/metrics", {
      headers: {
        host: "evil.example:3000",
        authorization: `Bearer ${"a".repeat(32)}`,
      },
    });
    expect(proxy(incoming).status).toBe(403);
  });

  it("requires the per-launch desktop token when the desktop runtime enables it", () => {
    const desktopToken = "desktop-session-token-7f3c9a2b5d8e1f4a";
    runtime.getServerConfig.mockReturnValue({
      mode: "local",
      appOrigin: runtime.appOrigin,
      desktopSessionToken: desktopToken,
    });

    expect(proxy(request("127.0.0.1:3000")).status).toBe(401);
    const authorized = new NextRequest(
      "http://127.0.0.1:3000/inventory",
      {
        headers: {
          host: "127.0.0.1:3000",
          authorization: `Bearer ${desktopToken}`,
        },
      },
    );
    expect(proxy(authorized).status).toBe(200);
  });
});
