import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopLogger } from "./logger";
import { safeError, silentLogger } from "./logger";

export interface UtilityProcessLike {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  once(event: "spawn", listener: () => void): this;
  once(event: "exit", listener: (code: number) => void): this;
  postMessage(message: unknown): void;
  kill(): boolean;
}

export interface UtilityForkOptions {
  cwd: string;
  env: Record<string, string>;
  serviceName?: string;
  stdio: "pipe";
}

export interface UtilityProcessAdapter {
  fork(
    modulePath: string,
    args: readonly string[],
    options: UtilityForkOptions,
  ): UtilityProcessLike;
}

export interface UtilityProcessSpec {
  name: string;
  hostModule: string;
  targetModule: string;
  cwd: string;
  environment: Record<string, string>;
  stopTimeoutMs?: number;
  maxOutputBytes?: number;
}

interface UtilityExit {
  code: number;
  stdout: string;
  stderr: string;
}

export class ManagedUtilityProcess {
  readonly #adapter: UtilityProcessAdapter;
  readonly #spec: UtilityProcessSpec;
  readonly #logger: DesktopLogger;
  #child?: UtilityProcessLike;
  #exitPromise?: Promise<UtilityExit>;

  constructor(
    spec: UtilityProcessSpec,
    options: {
      adapter: UtilityProcessAdapter;
      logger?: DesktopLogger;
    },
  ) {
    this.#spec = spec;
    this.#adapter = options.adapter;
    this.#logger = options.logger ?? silentLogger;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get running(): boolean {
    return Boolean(this.#child);
  }

  async start(): Promise<void> {
    if (this.#child) return;
    const child = this.#adapter.fork(
      this.#spec.hostModule,
      [this.#spec.targetModule],
      {
        cwd: this.#spec.cwd,
        env: this.#spec.environment,
        serviceName: this.#spec.name,
        stdio: "pipe",
      },
    );
    this.#child = child;
    const maximumBytes = this.#spec.maxOutputBytes ?? 64 * 1024;
    const stdout = collectUtilityOutput(
      child.stdout,
      maximumBytes,
      (line) => this.#logLine("stdout", line),
    );
    const stderr = collectUtilityOutput(
      child.stderr,
      maximumBytes,
      (line) => this.#logLine("stderr", line),
    );
    this.#exitPromise = new Promise<UtilityExit>((resolve) => {
      child.once("exit", (code) => {
        this.#child = undefined;
        resolve({ code, stdout: stdout.value(), stderr: stderr.value() });
      });
    });
    await Promise.race([
      new Promise<void>((resolve) => child.once("spawn", resolve)),
      this.#exitPromise.then(({ code }) => {
        throw new Error(
          `${this.#spec.name} exited before startup (code ${code}).`,
        );
      }),
    ]);
    this.#logger.info({
      event: "utility_started",
      process: this.#spec.name,
      pid: child.pid,
    });
  }

  async waitForExit(): Promise<UtilityExit> {
    return (
      this.#exitPromise ?? Promise.resolve({ code: 0, stdout: "", stderr: "" })
    );
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    child.postMessage({ type: "hardware:stop" });
    const exited = await Promise.race([
      this.waitForExit().then(() => true),
      delay(this.#spec.stopTimeoutMs ?? 15_000, false),
    ]);
    if (!exited && this.#child) {
      this.#logger.warn({
        event: "utility_force_stop",
        process: this.#spec.name,
      });
      child.kill();
      await Promise.race([this.waitForExit(), delay(2_000)]);
    }
    this.#child = undefined;
    this.#exitPromise = undefined;
  }

  #logLine(stream: "stdout" | "stderr", line: string): void {
    this.#logger.debug({
      event: "utility_output",
      process: this.#spec.name,
      stream,
      output: sanitizeUtilityOutput(line),
    });
  }
}

export class UtilityCommandRunner {
  readonly #adapter: UtilityProcessAdapter;
  readonly #hostModule: string;
  readonly #logger: DesktopLogger;

  constructor(options: {
    adapter: UtilityProcessAdapter;
    hostModule: string;
    logger?: DesktopLogger;
  }) {
    this.#adapter = options.adapter;
    this.#hostModule = options.hostModule;
    this.#logger = options.logger ?? silentLogger;
  }

  async run(options: {
    name: string;
    targetModule: string;
    cwd: string;
    environment: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const child = new ManagedUtilityProcess(
      {
        name: options.name,
        hostModule: this.#hostModule,
        targetModule: options.targetModule,
        cwd: options.cwd,
        environment: options.environment,
      },
      { adapter: this.#adapter, logger: this.#logger },
    );
    await child.start();
    const abortPromise = options.signal
      ? new Promise<never>((_resolve, reject) => {
          const abort = () =>
            reject(
              options.signal?.reason ??
                new Error(`${options.name} was cancelled.`),
            );
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort, { once: true });
        })
      : new Promise<never>(() => undefined);
    const result = await Promise.race([
      child.waitForExit(),
      delay(options.timeoutMs).then(() => {
        throw new Error(`${options.name} timed out.`);
      }),
      abortPromise,
    ]).catch(async (error) => {
      await child.stop().catch(() => undefined);
      throw error;
    });
    if (result.code !== 0) {
      this.#logger.error({
        event: "utility_command_failed",
        process: options.name,
        exitCode: result.code,
        ...safeError(new Error(options.name)),
      });
      throw new Error(`${options.name} exited unsuccessfully.`);
    }
  }
}

function collectUtilityOutput(
  stream: NodeJS.ReadableStream | null,
  maximumBytes: number,
  onLine: (line: string) => void,
): { value(): string } {
  if (!stream) return { value: () => "" };
  const chunks: Buffer[] = [];
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let lineBuffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes < maximumBytes) {
      const available = maximumBytes - bytes;
      chunks.push(buffer.subarray(0, available));
      bytes += Math.min(buffer.byteLength, available);
    }
    lineBuffer += decoder.write(buffer);
    let newline = lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line) onLine(line.slice(0, 2_000));
      newline = lineBuffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    lineBuffer += decoder.end();
    if (lineBuffer) onLine(lineBuffer.slice(0, 2_000));
  });
  return { value: () => Buffer.concat(chunks).toString("utf8") };
}

function sanitizeUtilityOutput(line: string): string {
  return line
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [Redacted]")
    .replace(/postgresql:\/\/[^\s"'\\]+/gi, "[database-url-redacted]")
    .replace(
      /("(?:credential|password|token|apiKey)"\s*:\s*)"[^"]*"/gi,
      '$1"[Redacted]"',
    );
}
