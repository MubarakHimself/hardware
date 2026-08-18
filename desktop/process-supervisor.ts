import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopLogger } from "./logger";
import { safeError, silentLogger } from "./logger";

export interface CommandSpec {
  name: string;
  executable: string;
  args?: readonly string[];
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessSpec extends Omit<CommandSpec, "stdin" | "timeoutMs"> {
  stopTimeoutMs?: number;
}

export interface SpawnAdapter {
  spawn(
    executable: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio & {
      stdio: ["pipe", "pipe", "pipe"];
    },
  ): ChildProcessWithoutNullStreams;
}

const nodeSpawnAdapter: SpawnAdapter = {
  spawn: (executable, args, options) =>
    spawn(executable, args, options) as ChildProcessWithoutNullStreams,
};

function childOptions(
  spec: CommandSpec | ProcessSpec,
): SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] } {
  return {
    cwd: spec.cwd,
    env: {
      ...process.env,
      ...spec.environment,
    },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  };
}

function collectBounded(
  stream: NodeJS.ReadableStream,
  maximumBytes: number,
  onLine?: (line: string) => void,
): { value: () => string } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const decoder = new StringDecoder("utf8");
  let lineBuffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes < maximumBytes) {
      const available = maximumBytes - bytes;
      chunks.push(buffer.subarray(0, available));
      bytes += Math.min(buffer.byteLength, available);
    }
    if (onLine) {
      lineBuffer += decoder.write(buffer);
      let newline = lineBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line) onLine(line.slice(0, 2_000));
        newline = lineBuffer.indexOf("\n");
      }
    }
  });
  stream.on("end", () => {
    if (!onLine) return;
    lineBuffer += decoder.end();
    if (lineBuffer) onLine(lineBuffer.slice(0, 2_000));
  });
  return { value: () => Buffer.concat(chunks).toString("utf8") };
}

export class CommandRunner {
  readonly #spawnAdapter: SpawnAdapter;
  readonly #logger: DesktopLogger;

  constructor(
    options: {
      spawnAdapter?: SpawnAdapter;
      logger?: DesktopLogger;
    } = {},
  ) {
    this.#spawnAdapter = options.spawnAdapter ?? nodeSpawnAdapter;
    this.#logger = options.logger ?? silentLogger;
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    const maximumBytes = spec.maxOutputBytes ?? 64 * 1024;
    const child = this.#spawnAdapter.spawn(
      spec.executable,
      spec.args ?? [],
      childOptions(spec),
    );
    const stdout = collectBounded(child.stdout, maximumBytes);
    const stderr = collectBounded(child.stderr, maximumBytes);
    if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeoutMs ?? 60_000);
    timeout.unref();

    try {
      const result = await new Promise<CommandResult>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (timedOut) {
            reject(new Error(`${spec.name} timed out.`));
            return;
          }
          if (signal) {
            reject(new Error(`${spec.name} stopped with signal ${signal}.`));
            return;
          }
          resolve({
            exitCode: code ?? 1,
            stdout: stdout.value(),
            stderr: stderr.value(),
          });
        });
      });
      if (result.exitCode !== 0) {
        const error = new Error(`${spec.name} exited unsuccessfully.`);
        Object.assign(error, {
          code: "COMMAND_FAILED",
          exitCode: result.exitCode,
        });
        throw error;
      }
      return result;
    } catch (error) {
      this.#logger.error(
        { event: "command_failed", command: spec.name, ...safeError(error) },
        `${spec.name} failed`,
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ManagedProcess {
  readonly #spec: ProcessSpec;
  readonly #spawnAdapter: SpawnAdapter;
  readonly #logger: DesktopLogger;
  #child?: ChildProcessWithoutNullStreams;
  #exitPromise?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(
    spec: ProcessSpec,
    options: {
      spawnAdapter?: SpawnAdapter;
      logger?: DesktopLogger;
    } = {},
  ) {
    this.#spec = spec;
    this.#spawnAdapter = options.spawnAdapter ?? nodeSpawnAdapter;
    this.#logger = options.logger ?? silentLogger;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get running(): boolean {
    return Boolean(this.#child && this.#child.exitCode === null);
  }

  async start(): Promise<void> {
    if (this.running) return;
    const child = this.#spawnAdapter.spawn(
      this.#spec.executable,
      this.#spec.args ?? [],
      childOptions(this.#spec),
    );
    this.#child = child;
    child.stdin.end();
    const logLine = (stream: "stdout" | "stderr") => (line: string) => {
      this.#logger.debug(
        {
          event: "child_output",
          process: this.#spec.name,
          stream,
          output: line,
        },
        `${this.#spec.name} output`,
      );
    };
    collectBounded(
      child.stdout,
      this.#spec.maxOutputBytes ?? 64 * 1024,
      logLine("stdout"),
    );
    collectBounded(
      child.stderr,
      this.#spec.maxOutputBytes ?? 64 * 1024,
      logLine("stderr"),
    );
    this.#exitPromise = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.#logger.info(
      {
        event: "child_started",
        process: this.#spec.name,
        pid: child.pid,
      },
      `${this.#spec.name} started`,
    );
  }

  async waitForExit(): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    if (!this.#exitPromise) return { code: 0, signal: null };
    return this.#exitPromise;
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    child.kill(signal);
    const timeoutMs = this.#spec.stopTimeoutMs ?? 10_000;
    const completed = await Promise.race([
      this.waitForExit().then(() => true),
      delay(timeoutMs, false),
    ]);
    if (!completed && child.exitCode === null) {
      this.#logger.warn(
        { event: "child_force_stop", process: this.#spec.name },
        `${this.#spec.name} did not stop in time`,
      );
      child.kill("SIGKILL");
      await Promise.race([
        this.waitForExit(),
        delay(2_000).then(() => ({ code: null, signal: null })),
      ]);
    }
    this.#child = undefined;
    this.#exitPromise = undefined;
  }
}

