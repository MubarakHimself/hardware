import { lookup } from "node:dns/promises";
import { request as requestHttp, type RequestOptions } from "node:http";
import { request as requestHttps } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";

export const SAFE_FETCH_MAX_REDIRECTS = 3;
export const SAFE_FETCH_TIMEOUT_MS = 10_000;
export const SAFE_FETCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type SafeFetchErrorCode =
  | "ABORTED"
  | "BLOCKED_ADDRESS"
  | "DNS_NO_ADDRESSES"
  | "DNS_RESOLUTION_FAILED"
  | "FETCH_FAILED"
  | "HTTP_STATUS"
  | "INVALID_DNS_ADDRESS"
  | "INVALID_URL"
  | "REDIRECT_WITHOUT_LOCATION"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "TOO_MANY_REDIRECTS"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "UNSUPPORTED_PROTOCOL"
  | "URL_HAS_CREDENTIALS";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  readonly url?: string;
  readonly status?: number;

  constructor(
    code: SafeFetchErrorCode,
    message: string,
    options: { cause?: unknown; status?: number; url?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SafeFetchError";
    this.code = code;
    this.url = options.url;
    this.status = options.status;
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly ResolvedAddress[]>;

export interface FetchHopContext {
  readonly resolvedAddresses: readonly ResolvedAddress[];
}

export type SafeFetchImplementation = (
  input: string,
  init: RequestInit,
  context: FetchHopContext,
) => Promise<Response>;

export interface SafeFetchOptions {
  fetch?: SafeFetchImplementation;
  resolveDns?: DnsResolver;
  signal?: AbortSignal;
  /** May lower, but never raise, the production timeout. */
  timeoutMs?: number;
  /** May lower, but never raise, the production redirect limit. */
  maxRedirects?: number;
  /** May lower, but never raise, the decompressed response limit. */
  maxResponseBytes?: number;
}

export interface SafeHtmlFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: "text/html" | "application/xhtml+xml";
  html: string;
  redirectCount: number;
}

interface ParsedIpv6 {
  value: bigint;
}

interface IpRangeV4 {
  base: number;
  prefix: number;
}

interface IpRangeV6 {
  base: bigint;
  prefix: number;
}

function parseIpv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return undefined;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return undefined;
    }
    value = (value * 256 + octet) >>> 0;
  }
  return value >>> 0;
}

function parseIpv6(address: string): ParsedIpv6 | undefined {
  let source = address.trim().toLowerCase();
  if (source.startsWith("[") && source.endsWith("]")) {
    source = source.slice(1, -1);
  }
  if (source.length === 0 || source.includes("%")) return undefined;

  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    if (lastColon < 0) return undefined;
    const ipv4 = parseIpv4(source.slice(lastColon + 1));
    if (ipv4 === undefined) return undefined;
    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    source = `${source.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColonParts = source.split("::");
  if (doubleColonParts.length > 2) return undefined;

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":")
    : [];
  const right = doubleColonParts.length === 2 && doubleColonParts[1]
    ? doubleColonParts[1].split(":")
    : [];

  if (doubleColonParts.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (doubleColonParts.length === 2 && missing < 1) return undefined;

  const components = [
    ...left,
    ...Array.from({ length: Math.max(0, missing) }, () => "0"),
    ...right,
  ];
  if (components.length !== 8) return undefined;

  let value = 0n;
  for (const component of components) {
    if (!/^[0-9a-f]{1,4}$/u.test(component)) return undefined;
    value = (value << 16n) | BigInt(`0x${component}`);
  }

  return { value };
}

function ipv4Range(cidr: string): IpRangeV4 {
  const [address, prefixText] = cidr.split("/");
  const base = parseIpv4(address);
  const prefix = Number(prefixText);
  if (base === undefined || !Number.isInteger(prefix)) {
    throw new Error(`Invalid internal IPv4 range: ${cidr}`);
  }
  return { base, prefix };
}

function ipv6Range(cidr: string): IpRangeV6 {
  const [address, prefixText] = cidr.split("/");
  const parsed = parseIpv6(address);
  const prefix = Number(prefixText);
  if (!parsed || !Number.isInteger(prefix)) {
    throw new Error(`Invalid internal IPv6 range: ${cidr}`);
  }
  return { base: parsed.value, prefix };
}

const BLOCKED_IPV4_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.31.196.0/24",
  "192.52.193.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "192.175.48.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map(ipv4Range);

const BLOCKED_IPV6_RANGES = [
  "::/128",
  "::1/128",
  "::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fec0::/10",
  "fe80::/10",
  "ff00::/8",
].map(ipv6Range);

const IPV4_MAPPED_IPV6 = ipv6Range("::ffff:0:0/96");
const NAT64_WELL_KNOWN = ipv6Range("64:ff9b::/96");
const GLOBAL_UNICAST_IPV6 = ipv6Range("2000::/3");

function matchesIpv4Range(value: number, range: IpRangeV4): boolean {
  if (range.prefix === 0) return true;
  const mask = (0xffffffff << (32 - range.prefix)) >>> 0;
  return ((value & mask) >>> 0) === ((range.base & mask) >>> 0);
}

function matchesIpv6Range(value: bigint, range: IpRangeV6): boolean {
  if (range.prefix === 0) return true;
  const shift = BigInt(128 - range.prefix);
  return value >> shift === range.base >> shift;
}

function isBlockedIpv4Number(value: number): boolean {
  return BLOCKED_IPV4_RANGES.some((range) => matchesIpv4Range(value, range));
}

/** True for non-public, private, loopback, link-local, test, or reserved IPs. */
export function isBlockedIpAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== undefined) {
    return isBlockedIpv4Number(ipv4);
  }

  const ipv6 = parseIpv6(address);
  if (!ipv6) {
    return true;
  }

  if (matchesIpv6Range(ipv6.value, IPV4_MAPPED_IPV6)) {
    return isBlockedIpv4Number(Number(ipv6.value & 0xffffffffn) >>> 0);
  }
  if (matchesIpv6Range(ipv6.value, NAT64_WELL_KNOWN)) {
    return isBlockedIpv4Number(Number(ipv6.value & 0xffffffffn) >>> 0);
  }
  if (!matchesIpv6Range(ipv6.value, GLOBAL_UNICAST_IPV6)) {
    return true;
  }

  return BLOCKED_IPV6_RANGES.some((range) => matchesIpv6Range(ipv6.value, range));
}

function parseLiteralAddress(hostname: string): ResolvedAddress | undefined {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (parseIpv4(unwrapped) !== undefined) {
    return { address: unwrapped, family: 4 };
  }
  if (parseIpv6(unwrapped)) {
    return { address: unwrapped, family: 6 };
  }
  return undefined;
}

const defaultDnsResolver: DnsResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

/** Build a socket lookup that can only return one previously validated address. */
export function createPinnedLookup(resolved: ResolvedAddress): LookupFunction {
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const wantsAll = typeof options === "object" && options !== null && "all" in options && (options as { all?: boolean }).all === true;
    if (wantsAll) {
      callback(null, [{ address: resolved.address, family: resolved.family }]);
    } else {
      callback(null, resolved.address, resolved.family);
    }
  }) as LookupFunction;
}

async function pinnedRequest(input: string, init: RequestInit, resolved: ResolvedAddress): Promise<Response> {
  const url = new URL(input);
  const request = url.protocol === "https:" ? requestHttps : requestHttp;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const options: RequestOptions = {
    method: init.method ?? "GET",
    headers,
    lookup: createPinnedLookup(resolved),
    // Never pool a socket across validation hops or hostnames.
    agent: false,
    signal: init.signal ?? undefined,
  };

  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, options, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value !== undefined) {
          responseHeaders.set(name, String(value));
        }
      }
      const mayHaveBody = incoming.statusCode !== 204 && incoming.statusCode !== 205 && incoming.statusCode !== 304;
      const body = mayHaveBody ? Readable.toWeb(incoming) as ReadableStream<Uint8Array> : null;
      resolve(new Response(body, {
        status: incoming.statusCode ?? 500,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

const defaultFetch: SafeFetchImplementation = async (input, init, context) => {
  let lastError: unknown;
  for (const resolved of context.resolvedAddresses) {
    try {
      // The URL hostname remains unchanged, preserving the HTTP Host header and
      // TLS SNI/certificate validation while lookup is pinned to this address.
      return await pinnedRequest(input, init, resolved);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error("No validated website addresses were available.");
};

function limitedPositiveInteger(
  requested: number | undefined,
  maximum: number,
): number {
  if (requested === undefined || !Number.isFinite(requested)) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(requested)));
}

function limitedRedirects(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return SAFE_FETCH_MAX_REDIRECTS;
  }
  return Math.max(0, Math.min(SAFE_FETCH_MAX_REDIRECTS, Math.floor(requested)));
}

function validateTargetUrl(value: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch (error) {
    throw new SafeFetchError("INVALID_URL", "Website URL is invalid.", {
      cause: error,
      url: value,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError(
      "UNSUPPORTED_PROTOCOL",
      "Only HTTP(S) website URLs may be fetched.",
      { url: url.toString() },
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new SafeFetchError(
      "URL_HAS_CREDENTIALS",
      "Website URLs containing credentials are rejected.",
      { url: url.toString() },
    );
  }
  return url;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Operation aborted"));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function resolvePublicAddresses(
  url: URL,
  resolver: DnsResolver,
  signal: AbortSignal,
): Promise<readonly ResolvedAddress[]> {
  const literal = parseLiteralAddress(url.hostname);
  let addresses: readonly ResolvedAddress[];

  if (literal) {
    addresses = [literal];
  } else {
    try {
      addresses = await abortable(resolver(url.hostname, signal), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SafeFetchError(
        "DNS_RESOLUTION_FAILED",
        "DNS resolution failed for the website host.",
        { cause: error, url: url.toString() },
      );
    }
  }

  if (addresses.length === 0) {
    throw new SafeFetchError(
      "DNS_NO_ADDRESSES",
      "DNS returned no addresses for the website host.",
      { url: url.toString() },
    );
  }

  for (const resolved of addresses) {
    const valid = resolved.family === 4
      ? parseIpv4(resolved.address) !== undefined
      : parseIpv6(resolved.address) !== undefined;
    if (!valid) {
      throw new SafeFetchError(
        "INVALID_DNS_ADDRESS",
        "DNS returned an invalid address.",
        { url: url.toString() },
      );
    }
    if (isBlockedIpAddress(resolved.address)) {
      throw new SafeFetchError(
        "BLOCKED_ADDRESS",
        "Website target resolves to a private or reserved address.",
        { url: url.toString() },
      );
    }
  }

  return addresses;
}

function responseMimeType(response: Response, url: URL): SafeHtmlFetchResult["contentType"] {
  const header = response.headers.get("content-type") ?? "";
  const mimeType = header.split(";", 1)[0].trim().toLowerCase();
  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
    return mimeType;
  }
  throw new SafeFetchError(
    "UNSUPPORTED_CONTENT_TYPE",
    "Website metadata requires HTML or XHTML content.",
    { status: response.status, url: url.toString() },
  );
}

function responseCharset(response: Response): string {
  const header = response.headers.get("content-type") ?? "";
  const match = header.match(/charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/iu);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "utf-8").trim();
}

function createDecoder(charset: string): TextDecoder {
  try {
    return new TextDecoder(charset, { fatal: false });
  } catch {
    return new TextDecoder("utf-8", { fatal: false });
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  url: URL,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = createDecoder(responseCharset(response));
  const chunks: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      receivedBytes += item.value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SafeFetchError(
          "RESPONSE_TOO_LARGE",
          `Decompressed HTML exceeds the ${maximumBytes}-byte limit.`,
          { status: response.status, url: url.toString() },
        );
      }
      chunks.push(decoder.decode(item.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetch bounded HTML after validating every initial/redirect DNS destination.
 * The transport receives the validated addresses so production transports can
 * pin their socket lookup; test transports can assert the same hop contract.
 */
export async function safeFetchHtml(
  requestedUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeHtmlFetchResult> {
  const fetchImplementation = options.fetch ?? defaultFetch;
  const resolver = options.resolveDns ?? defaultDnsResolver;
  const timeoutMs = limitedPositiveInteger(options.timeoutMs, SAFE_FETCH_TIMEOUT_MS);
  const maxRedirects = limitedRedirects(options.maxRedirects);
  const maxResponseBytes = limitedPositiveInteger(
    options.maxResponseBytes,
    SAFE_FETCH_MAX_RESPONSE_BYTES,
  );
  let currentUrl = validateTargetUrl(requestedUrl);

  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error("Safe fetch timed out"));
  }, timeoutMs);
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();

  let redirectCount = 0;

  try {
    while (true) {
      const resolvedAddresses = await resolvePublicAddresses(
        currentUrl,
        resolver,
        controller.signal,
      );

      let response: Response;
      try {
        response = await abortable(
          fetchImplementation(
            currentUrl.toString(),
            {
              cache: "no-store",
              credentials: "omit",
              headers: {
                accept: "text/html,application/xhtml+xml;q=0.9",
                "user-agent": "Hardware/1.0 (+website-metadata)",
              },
              redirect: "manual",
              referrerPolicy: "no-referrer",
              signal: controller.signal,
            },
            { resolvedAddresses },
          ),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        if (controller.signal.aborted) throw error;
        throw new SafeFetchError("FETCH_FAILED", "Website request failed.", {
          cause: error,
          url: currentUrl.toString(),
        });
      }

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new SafeFetchError(
            "REDIRECT_WITHOUT_LOCATION",
            "Redirect response did not include a Location header.",
            { status: response.status, url: currentUrl.toString() },
          );
        }
        if (redirectCount >= maxRedirects) {
          throw new SafeFetchError(
            "TOO_MANY_REDIRECTS",
            `Website exceeded the ${maxRedirects}-redirect limit.`,
            { status: response.status, url: currentUrl.toString() },
          );
        }
        currentUrl = validateTargetUrl(location, currentUrl);
        redirectCount += 1;
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SafeFetchError(
          "HTTP_STATUS",
          `Website returned HTTP ${response.status}.`,
          { status: response.status, url: currentUrl.toString() },
        );
      }

      let contentType: SafeHtmlFetchResult["contentType"];
      try {
        contentType = responseMimeType(response, currentUrl);
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
      const html = await readBoundedBody(
        response,
        maxResponseBytes,
        controller.signal,
        currentUrl,
      );
      return {
        requestedUrl,
        finalUrl: currentUrl.toString(),
        status: response.status,
        contentType,
        html,
        redirectCount,
      };
    }
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    if (controller.signal.aborted) {
      throw new SafeFetchError(
        didTimeout ? "TIMEOUT" : "ABORTED",
        didTimeout
          ? `Website fetch exceeded the ${timeoutMs}ms timeout.`
          : "Website fetch was aborted.",
        { cause: error, url: currentUrl.toString() },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
