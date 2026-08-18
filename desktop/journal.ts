import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RuntimeStage } from "./types";

const journalSchema = z.object({
  formatVersion: z.literal(1),
  operationId: z.string().uuid(),
  phase: z.string(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RuntimeJournalEntry = z.infer<typeof journalSchema>;

export class RuntimeJournal {
  readonly #file: string;
  #entry?: RuntimeJournalEntry;

  constructor(file: string) {
    this.#file = file;
  }

  async readInterruptedOperation(): Promise<RuntimeJournalEntry | undefined> {
    try {
      return journalSchema.parse(JSON.parse(await readFile(this.#file, "utf8")));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined;
      }
      throw new Error("The runtime recovery journal is damaged.", {
        cause: error,
      });
    }
  }

  async begin(phase: RuntimeStage): Promise<void> {
    const now = new Date().toISOString();
    this.#entry = {
      formatVersion: 1,
      operationId: randomUUID(),
      phase,
      startedAt: now,
      updatedAt: now,
    };
    await this.#persist();
  }

  async transition(phase: RuntimeStage): Promise<void> {
    if (!this.#entry) {
      await this.begin(phase);
      return;
    }
    this.#entry = {
      ...this.#entry,
      phase,
      updatedAt: new Date().toISOString(),
    };
    await this.#persist();
  }

  async clear(): Promise<void> {
    this.#entry = undefined;
    await rm(this.#file, { force: true });
  }

  async #persist(): Promise<void> {
    if (!this.#entry) return;
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.#entry), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
