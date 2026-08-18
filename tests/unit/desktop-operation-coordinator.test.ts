import { describe, expect, it } from "vitest";
import {
  NativeOperationConflictError,
  NativeOperationCoordinator,
} from "../../desktop/operation-coordinator";

describe("native desktop operation serialization", () => {
  it("acquires ownership before the first await and blocks quit races", async () => {
    const operations = new NativeOperationCoordinator();
    let releaseBackup: (() => void) | undefined;
    const backup = operations.run(
      "backup",
      () =>
        new Promise<void>((resolve) => {
          releaseBackup = resolve;
        }),
    );

    expect(operations.active).toBe("backup");
    await expect(
      operations.run("lifecycle", async () => undefined),
    ).rejects.toBeInstanceOf(NativeOperationConflictError);
    expect(operations.active).toBe("backup");

    releaseBackup?.();
    await backup;
    expect(operations.active).toBeUndefined();
  });
});
