import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const windowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(1024),
  height: z.number().int().min(720),
});

export const desktopSettingsSchema = z.object({
  formatVersion: z.literal(1).default(1),
  onboardingCompleted: z.boolean().default(false),
  theme: z.enum(["light", "dark", "system"]).default("system"),
  recoveryKeyExported: z.boolean().default(false),
  backupDirectory: z.string().trim().min(1).optional(),
  lastBackupAt: z.string().datetime().optional(),
  lastSuccessfulVersion: z.string().trim().min(1).optional(),
  lastCleanShutdown: z.boolean().default(true),
  windowBounds: windowBoundsSchema.optional(),
  providers: z
    .partialRecord(
      z.enum(["youtube", "github"]),
      z.object({
        verified: z.boolean(),
        updatedAt: z.string().datetime(),
      }),
    )
    .default({}),
});

export type DesktopSettings = z.infer<typeof desktopSettingsSchema>;

export interface SettingsFileAdapter {
  read(file: string): Promise<string>;
  write(file: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(file: string): Promise<void>;
  makeDirectory(directory: string): Promise<void>;
}

const nodeFileAdapter: SettingsFileAdapter = {
  read: (file) => readFile(file, "utf8"),
  write: (file, contents) =>
    writeFile(file, contents, { encoding: "utf8", mode: 0o600, flag: "wx" }),
  rename,
  remove: (file) => rm(file, { force: true }),
  makeDirectory: (directory) =>
    mkdir(directory, { recursive: true, mode: 0o700 }).then(() => undefined),
};

export class DesktopSettingsStore {
  readonly #file: string;
  readonly #adapter: SettingsFileAdapter;
  #settings: DesktopSettings = desktopSettingsSchema.parse({});
  #writeChain = Promise.resolve();

  constructor(file: string, adapter: SettingsFileAdapter = nodeFileAdapter) {
    this.#file = file;
    this.#adapter = adapter;
  }

  async load(): Promise<DesktopSettings> {
    try {
      const contents = await this.#adapter.read(this.#file);
      this.#settings = desktopSettingsSchema.parse(JSON.parse(contents));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        this.#settings = desktopSettingsSchema.parse({});
        return this.snapshot();
      }
      throw new Error("Hardware settings could not be read safely.", {
        cause: error,
      });
    }
    return this.snapshot();
  }

  snapshot(): DesktopSettings {
    return structuredClone(this.#settings);
  }

  async update(
    update:
      | Partial<DesktopSettings>
      | ((current: DesktopSettings) => DesktopSettings),
  ): Promise<DesktopSettings> {
    const next =
      typeof update === "function"
        ? update(this.snapshot())
        : { ...this.#settings, ...update };
    this.#settings = desktopSettingsSchema.parse(next);
    const snapshot = this.snapshot();
    this.#writeChain = this.#writeChain.then(() => this.#persist(snapshot));
    await this.#writeChain;
    return this.snapshot();
  }

  async #persist(settings: DesktopSettings): Promise<void> {
    const directory = path.dirname(this.#file);
    await this.#adapter.makeDirectory(directory);
    const temporaryFile = path.join(
      directory,
      `.${path.basename(this.#file)}.${randomUUID()}.tmp`,
    );
    try {
      await this.#adapter.write(
        temporaryFile,
        `${JSON.stringify(settings, null, 2)}\n`,
      );
      await this.#adapter.rename(temporaryFile, this.#file);
    } finally {
      await this.#adapter.remove(temporaryFile).catch(() => undefined);
    }
  }
}
