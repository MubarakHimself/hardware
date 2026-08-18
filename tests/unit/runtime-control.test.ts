import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertRuntimeAcceptingMutations,
  isRuntimeDraining,
  setRuntimeDraining,
} from "../../lib/server/runtime-control";

afterEach(() => {
  setRuntimeDraining(false);
});

describe("desktop runtime drain state", () => {
  it("shares one process-wide state and blocks ordinary mutations", () => {
    setRuntimeDraining(true);
    expect(isRuntimeDraining()).toBe(true);

    const request = new Request("http://127.0.0.1:3000/api/imports", {
      method: "POST",
    });
    expect(() => assertRuntimeAcceptingMutations(request)).toThrow(
      expect.objectContaining({
        code: "runtime_draining",
        status: 503,
      }),
    );
  });

  it("allows the authenticated runtime route to turn drain mode off", () => {
    setRuntimeDraining(true);
    const request = new Request(
      "http://127.0.0.1:3000/api/internal/runtime/drain",
      { method: "POST" },
    );

    expect(() => assertRuntimeAcceptingMutations(request)).not.toThrow();
    expect(setRuntimeDraining(false)).toEqual({ draining: false });
  });
});
