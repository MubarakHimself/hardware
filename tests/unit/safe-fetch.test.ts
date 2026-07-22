import { describe, expect, it, vi } from "vitest";
import {
  SAFE_FETCH_MAX_REDIRECTS,
  SAFE_FETCH_MAX_RESPONSE_BYTES,
  SAFE_FETCH_TIMEOUT_MS,
  createPinnedLookup,
  isBlockedIpAddress,
  safeFetchHtml,
  type DnsResolver,
  type ResolvedAddress,
  type SafeFetchImplementation,
} from "../../lib/ingestion";

const PUBLIC_IPV4: readonly ResolvedAddress[] = [
  { address: "93.184.216.34", family: 4 },
];

const publicDns: DnsResolver = async () => PUBLIC_IPV4;

function htmlResponse(
  html: string,
  init: { contentType?: string; headers?: HeadersInit; status?: number } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", init.contentType ?? "text/html; charset=utf-8");
  return new Response(html, { status: init.status ?? 200, headers });
}

describe("SSRF address policy", () => {
  it("pins socket lookup to the prevalidated address even if the hostname could rebind", async () => {
    const pinned = createPinnedLookup({ address: "93.184.216.34", family: 4 });
    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      pinned("attacker-controlled.example", { all: false }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family: Number(family) });
      });
    });
    expect(resolved).toEqual({ address: "93.184.216.34", family: 4 });
    expect(resolved.address).not.toBe("127.0.0.1");
  });

  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.10",
    "198.18.0.1",
    "198.51.100.2",
    "203.0.113.2",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "1000::1",
    "2001:db8::1",
    "3fff::1",
    "4000::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
  ])("blocks private or reserved address %s", (address) => {
    expect(isBlockedIpAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
  ])("allows public address %s", (address) => {
    expect(isBlockedIpAddress(address)).toBe(false);
  });

  it("treats malformed addresses as blocked", () => {
    expect(isBlockedIpAddress("not-an-ip")).toBe(true);
    expect(isBlockedIpAddress("300.1.1.1")).toBe(true);
    expect(isBlockedIpAddress("fe80::1%eth0")).toBe(true);
  });
});

describe("safeFetchHtml", () => {
  it("enforces the production maximum limits", () => {
    expect(SAFE_FETCH_MAX_REDIRECTS).toBe(3);
    expect(SAFE_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(SAFE_FETCH_MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
  });

  it("fetches HTML through injected DNS and transport only", async () => {
    const resolver = vi.fn<DnsResolver>(publicDns);
    const transport = vi.fn<SafeFetchImplementation>(
      async (_input, init, context) => {
        expect(init.redirect).toBe("manual");
        expect(init.credentials).toBe("omit");
        expect(context.resolvedAddresses).toEqual(PUBLIC_IPV4);
        return htmlResponse("<title>Safe</title>");
      },
    );

    const fetched = await safeFetchHtml("https://example.com/project", {
      fetch: transport,
      resolveDns: resolver,
    });

    expect(fetched).toEqual({
      requestedUrl: "https://example.com/project",
      finalUrl: "https://example.com/project",
      status: 200,
      contentType: "text/html",
      html: "<title>Safe</title>",
      redirectCount: 0,
    });
    expect(resolver).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("re-resolves and validates every redirect before the next request", async () => {
    const resolver = vi.fn<DnsResolver>(async (hostname) =>
      hostname === "public.example"
        ? PUBLIC_IPV4
        : [{ address: "127.0.0.1", family: 4 }],
    );
    const transport = vi.fn<SafeFetchImplementation>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://private.example/admin" },
      }),
    );

    await expect(
      safeFetchHtml("https://public.example", {
        fetch: transport,
        resolveDns: resolver,
      }),
    ).rejects.toMatchObject({
      code: "BLOCKED_ADDRESS",
    });

    expect(resolver.mock.calls.map(([hostname]) => hostname)).toEqual([
      "public.example",
      "private.example",
    ]);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("re-resolves the same hostname on a safe redirect", async () => {
    const resolver = vi.fn<DnsResolver>(publicDns);
    let request = 0;
    const transport = vi.fn<SafeFetchImplementation>(async () => {
      request += 1;
      return request === 1
        ? new Response(null, {
            status: 301,
            headers: { location: "/final" },
          })
        : htmlResponse("<title>Final</title>", {
            contentType: "application/xhtml+xml; charset=utf-8",
          });
    });

    const fetched = await safeFetchHtml("https://example.com/start", {
      fetch: transport,
      resolveDns: resolver,
    });

    expect(fetched.finalUrl).toBe("https://example.com/final");
    expect(fetched.contentType).toBe("application/xhtml+xml");
    expect(fetched.redirectCount).toBe(1);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("blocks a private literal or any private DNS answer before transport", async () => {
    const resolver = vi.fn<DnsResolver>(async () => [
      ...PUBLIC_IPV4,
      { address: "10.0.0.5", family: 4 },
    ]);
    const transport = vi.fn<SafeFetchImplementation>(async () => htmlResponse(""));

    await expect(
      safeFetchHtml("http://127.0.0.1", {
        fetch: transport,
        resolveDns: resolver,
      }),
    ).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    await expect(
      safeFetchHtml("https://mixed.example", {
        fetch: transport,
        resolveDns: resolver,
      }),
    ).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("permits no more than three redirects", async () => {
    const resolver = vi.fn<DnsResolver>(publicDns);
    let hop = 0;
    const transport = vi.fn<SafeFetchImplementation>(async () => {
      hop += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `/hop-${hop}` },
      });
    });

    await expect(
      safeFetchHtml("https://example.com/start", {
        fetch: transport,
        resolveDns: resolver,
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(resolver).toHaveBeenCalledTimes(4);
  });

  it("caps the delivered decompressed body bytes", async () => {
    const transport: SafeFetchImplementation = async () =>
      htmlResponse("0123456789abcdefX");

    await expect(
      safeFetchHtml("https://example.com", {
        fetch: transport,
        resolveDns: publicDns,
        maxResponseBytes: 16,
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("rejects non-HTML responses and unsuccessful statuses", async () => {
    await expect(
      safeFetchHtml("https://example.com/file", {
        fetch: async () =>
          htmlResponse("{}", { contentType: "application/json" }),
        resolveDns: publicDns,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT_TYPE" });

    await expect(
      safeFetchHtml("https://example.com/missing", {
        fetch: async () => htmlResponse("missing", { status: 404 }),
        resolveDns: publicDns,
      }),
    ).rejects.toMatchObject({ code: "HTTP_STATUS", status: 404 });
  });

  it("applies one total timeout to DNS, redirects, fetch, and body", async () => {
    await expect(
      safeFetchHtml("https://example.com", {
        fetch: async () => new Promise<Response>(() => undefined),
        resolveDns: publicDns,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("rejects unsupported schemes and URL credentials before DNS", async () => {
    const resolver = vi.fn<DnsResolver>(publicDns);
    const transport = vi.fn<SafeFetchImplementation>(async () => htmlResponse(""));

    await expect(
      safeFetchHtml("file:///etc/passwd", {
        fetch: transport,
        resolveDns: resolver,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    await expect(
      safeFetchHtml("https://user:pass@example.com", {
        fetch: transport,
        resolveDns: resolver,
      }),
    ).rejects.toMatchObject({ code: "URL_HAS_CREDENTIALS" });
    expect(resolver).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});
