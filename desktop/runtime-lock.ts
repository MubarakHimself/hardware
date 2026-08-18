import { open, readFile, rm, type FileHandle } from "node:fs/promises";

export class RuntimeLock {
  readonly #file: string;
  #handle?: FileHandle;

  constructor(file: string) {
    this.#file = file;
  }

  async acquire(): Promise<void> {
    if (this.#handle) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.#handle = await open(this.#file, "wx", 0o600);
        await this.#handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
          }),
          "utf8",
        );
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error as NodeJS.ErrnoException).code !== "EEXIST"
        ) {
          throw error;
        }
        const pid = await this.#readPid();
        if (pid && isProcessAlive(pid)) {
          throw new Error("Another Hardware runtime is already active.");
        }
        await rm(this.#file, { force: true });
      }
    }
    throw new Error("Hardware could not acquire its runtime lock.");
  }

  async release(): Promise<void> {
    await this.#handle?.close().catch(() => undefined);
    this.#handle = undefined;
    await rm(this.#file, { force: true }).catch(() => undefined);
  }

  async #readPid(): Promise<number | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as {
        pid?: unknown;
      };
      return typeof parsed.pid === "number" &&
        Number.isSafeInteger(parsed.pid) &&
        parsed.pid > 0
        ? parsed.pid
        : undefined;
    } catch {
      return undefined;
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

