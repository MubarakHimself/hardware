export type NativeExclusiveOperation =
  | "backup"
  | "restore"
  | "provider"
  | "lifecycle"
  | "erase";

export class NativeOperationConflictError extends Error {
  constructor(active: NativeExclusiveOperation) {
    super(`Wait for the current ${active} operation to finish.`);
    this.name = "NativeOperationConflictError";
  }
}

export class NativeOperationCoordinator {
  #active?: NativeExclusiveOperation;

  get active(): NativeExclusiveOperation | undefined {
    return this.#active;
  }

  async run<T>(
    operation: NativeExclusiveOperation,
    callback: () => Promise<T>,
  ): Promise<T> {
    if (this.#active) throw new NativeOperationConflictError(this.#active);
    this.#active = operation;
    try {
      return await callback();
    } finally {
      this.#active = undefined;
    }
  }
}

