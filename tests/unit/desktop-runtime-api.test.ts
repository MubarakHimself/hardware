import { describe, expect, it, vi } from "vitest";
import { DesktopRuntimeApi } from "../../desktop/runtime-api";

describe("authenticated desktop runtime API", () => {
  it("sends the launch token explicitly to internal probes", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            status: "ready",
            database: "ready",
            worker: "ready",
            catalog: "ready",
            draining: false,
            release: "test",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const api = new DesktopRuntimeApi({
      sessionToken: "launch-secret",
      fetch: fetchMock,
    });
    api.setOrigin("http://127.0.0.1:43210");

    await expect(api.isReady()).resolves.toBe(true);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer launch-secret",
    );
  });

  it("rejects non-numeric or non-loopback origins", () => {
    const api = new DesktopRuntimeApi({ sessionToken: "secret" });
    expect(() => api.setOrigin("http://localhost:3000")).toThrow(
      /numeric loopback/i,
    );
    expect(() => api.setOrigin("https://127.0.0.1:3000")).toThrow(
      /numeric loopback/i,
    );
  });
});

