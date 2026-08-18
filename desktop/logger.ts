export interface DesktopLogger {
  debug(fields: Record<string, unknown>, message?: string): void;
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
  flush?(): Promise<void>;
}

import {
  appendFile,
  mkdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

export const silentLogger: DesktopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const SECRET_KEYS = new Set([
  "authorization",
  "credential",
  "databaseUrl",
  "dbPassword",
  "githubToken",
  "password",
  "sessionToken",
  "token",
  "youtubeApiKey",
]);

export function redactLogFields(
  value: unknown,
  key = "",
): unknown {
  if (SECRET_KEYS.has(key)) return "[Redacted]";
  if (Array.isArray(value)) return value.map((item) => redactLogFields(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactLogFields(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function safeError(error: unknown): {
  errorName: string;
  errorCode?: string;
} {
  if (!(error instanceof Error)) return { errorName: "UnknownError" };
  const errorCode =
    "code" in error && typeof error.code === "string"
      ? error.code.slice(0, 80)
      : undefined;
  return { errorName: error.name, ...(errorCode ? { errorCode } : {}) };
}

export function createFileLogger(
  file: string,
  base: Record<string, unknown> = {},
  options: {
    minimumLevel?: "debug" | "info" | "warn" | "error";
    maximumBytes?: number;
    retainedFiles?: number;
  } = {},
): DesktopLogger {
  const minimumLevel = options.minimumLevel ?? "info";
  const maximumBytes = options.maximumBytes ?? 5 * 1024 * 1024;
  const retainedFiles = options.retainedFiles ?? 4;
  const priorities = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  } as const;
  let writeChain = Promise.resolve();

  const enqueue = (line: string): void => {
    writeChain = writeChain
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await rotateIfNeeded(
          file,
          Buffer.byteLength(line),
          maximumBytes,
          retainedFiles,
        );
        await appendFile(file, line, {
          encoding: "utf8",
          mode: 0o600,
        });
      })
      .catch(() => undefined);
  };

  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (fields: Record<string, unknown>, message?: string): void => {
      if (priorities[level] < priorities[minimumLevel]) return;
      const record = redactLogFields({
        level,
        time: new Date().toISOString(),
        ...base,
        ...fields,
        ...(message ? { message } : {}),
      });
      enqueue(`${JSON.stringify(record)}\n`);
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    flush: () => writeChain,
  };
}

async function rotateIfNeeded(
  file: string,
  incomingBytes: number,
  maximumBytes: number,
  retainedFiles: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !Number.isSafeInteger(retainedFiles) ||
    retainedFiles < 1
  ) {
    throw new Error("Invalid desktop log rotation configuration.");
  }
  const currentBytes = await stat(file)
    .then((value) => value.size)
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return 0;
      }
      throw error;
    });
  if (currentBytes === 0 || currentBytes + incomingBytes <= maximumBytes) {
    return;
  }

  await rm(`${file}.${retainedFiles}`, { force: true });
  for (let index = retainedFiles - 1; index >= 1; index -= 1) {
    await rename(`${file}.${index}`, `${file}.${index + 1}`).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return;
        }
        throw error;
      },
    );
  }
  await rename(file, `${file}.1`);
}
