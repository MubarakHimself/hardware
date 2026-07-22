export type IntegrationProvider = "github" | "youtube";

export class IntegrationError extends Error {
  readonly provider: IntegrationProvider;
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(options: {
    provider: IntegrationProvider;
    code: string;
    message: string;
    retryable: boolean;
    status?: number;
    retryAfterMs?: number;
  }) {
    super(options.message);
    this.name = "IntegrationError";
    this.provider = options.provider;
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

export interface JsonRequestOptions {
  fetchImplementation?: typeof fetch;
  headers?: HeadersInit;
  maximumBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAXIMUM_BYTES = 4 * 1024 * 1024;

class ResponseSizeError extends Error {}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted."));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Request aborted."));
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function readBoundedBody(response: Response, maximumBytes: number, signal: AbortSignal): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new ResponseSizeError("Response exceeded the configured size limit.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = "";
  try {
    while (true) {
      const chunk = await readWithSignal(reader, signal);
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new ResponseSizeError("Response exceeded the configured size limit.");
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function requestJson<T>(
  provider: IntegrationProvider,
  url: URL,
  options: JsonRequestOptions = {},
): Promise<JsonResponse<T>> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: options.headers,
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new IntegrationError({
        provider,
        code: `${provider.toUpperCase()}_TIMEOUT`,
        message: `${provider} did not respond before the request deadline.`,
        retryable: true,
      });
    }
    throw new IntegrationError({
      provider,
      code: `${provider.toUpperCase()}_NETWORK_ERROR`,
      message: `${provider} could not be reached.`,
      retryable: true,
    });
  }

  let bodyText: string;
  try {
    bodyText = await readBoundedBody(response, maximumBytes, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new IntegrationError({
        provider,
        code: `${provider.toUpperCase()}_TIMEOUT`,
        message: `${provider} did not respond before the request deadline.`,
        retryable: true,
        status: response.status,
      });
    }
    if (!(error instanceof ResponseSizeError)) {
      throw new IntegrationError({
        provider,
        code: `${provider.toUpperCase()}_NETWORK_ERROR`,
        message: `${provider} response body could not be read.`,
        retryable: true,
        status: response.status,
      });
    }
    throw new IntegrationError({
      provider,
      code: `${provider.toUpperCase()}_RESPONSE_TOO_LARGE`,
      message: `${provider} returned a response larger than the configured limit.`,
      retryable: false,
      status: response.status,
    });
  } finally {
    clearTimeout(timeout);
  }

  let data: unknown = {};
  if (bodyText.length > 0) {
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new IntegrationError({
        provider,
        code: `${provider.toUpperCase()}_INVALID_RESPONSE`,
        message: `${provider} returned malformed JSON.`,
        retryable: response.status >= 500,
        status: response.status,
      });
    }
  }

  return { data: data as T, headers: response.headers, status: response.status };
}
