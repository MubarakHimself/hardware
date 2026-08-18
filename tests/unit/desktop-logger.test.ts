import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileLogger } from "../../desktop/logger";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("desktop file logging", () => {
  it("filters debug output and redacts secret fields", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hardware-logs-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "desktop.log");
    const logger = createFileLogger(file);

    logger.debug({ event: "noisy_output" });
    logger.info({
      event: "provider_saved",
      githubToken: "must-not-appear",
    });
    await logger.flush?.();

    const contents = await readFile(file, "utf8");
    expect(contents).not.toContain("noisy_output");
    expect(contents).not.toContain("must-not-appear");
    expect(contents).toContain("[Redacted]");
  });

  it("rotates bounded log files without blocking callers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hardware-logs-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "desktop.log");
    const logger = createFileLogger(
      file,
      {},
      { maximumBytes: 220, retainedFiles: 2 },
    );

    for (let index = 0; index < 12; index += 1) {
      logger.info({ event: "rotation_test", index, payload: "x".repeat(80) });
    }
    await logger.flush?.();

    const files = await readdir(directory);
    expect(files).toContain("desktop.log");
    expect(files).toContain("desktop.log.1");
    expect(files).not.toContain("desktop.log.3");
  });
});
