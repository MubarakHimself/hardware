import "server-only";
import pino from "pino";

const globalLogger = globalThis as typeof globalThis & {
  __hardwareServerLogger?: pino.Logger;
};

export const serverLogger =
  globalLogger.__hardwareServerLogger ??
  (globalLogger.__hardwareServerLogger = pino({
    name: "hardware-web",
    level: process.env.LOG_LEVEL ?? "info",
    base: {
      service: "hardware-web",
      release: process.env.RELEASE_SHA ?? "development",
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.token",
        "*.secret",
        "*.description",
        "*.rawSegment",
        "*.note",
      ],
      censor: "[REDACTED]",
    },
  }));
