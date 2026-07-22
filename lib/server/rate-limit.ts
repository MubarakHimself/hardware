import "server-only";
import { ApiError } from "./errors";

interface WindowState {
  count: number;
  resetsAt: number;
}

const globalRateLimits = globalThis as typeof globalThis & {
  __hardwareRateLimits?: Map<string, WindowState>;
};

const windows =
  globalRateLimits.__hardwareRateLimits ??
  (globalRateLimits.__hardwareRateLimits = new Map());

export function enforceRateLimit(options: {
  actorId: string;
  bucket: string;
  maximum: number;
  windowMs: number;
}): void {
  const now = Date.now();
  const key = `${options.bucket}:${options.actorId}`;
  const existing = windows.get(key);
  const state =
    !existing || existing.resetsAt <= now
      ? { count: 0, resetsAt: now + options.windowMs }
      : existing;

  state.count += 1;
  windows.set(key, state);
  if (state.count > options.maximum) {
    const retryAfter = Math.max(1, Math.ceil((state.resetsAt - now) / 1_000));
    throw new ApiError({
      status: 429,
      code: "rate_limit_exceeded",
      title: "Too many requests",
      detail: "Please wait before trying this action again.",
      headers: { "retry-after": String(retryAfter) },
    });
  }

  if (windows.size > 10_000) {
    for (const [windowKey, value] of windows) {
      if (value.resetsAt <= now) windows.delete(windowKey);
    }
  }
}
