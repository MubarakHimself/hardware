import pino from "pino";

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "cookie",
  "token",
  "apiKey",
  "secret",
  "description",
  "rawSegment",
  "note",
  "body",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: process.env.SERVICE_NAME ?? "hardware-worker",
    release: process.env.RELEASE_SHA ?? "development",
  },
  redact: {
    paths: redactPaths,
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function safeErrorDetails(error: unknown): {
  errorName: string;
  errorCode?: string;
} {
  if (!(error instanceof Error)) return { errorName: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { errorName: error.name, errorCode: code };
}
