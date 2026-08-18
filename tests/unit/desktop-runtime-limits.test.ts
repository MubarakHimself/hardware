import { describe, expect, it } from "vitest";
import {
  DESKTOP_DATABASE_LIMITS,
  desktopDatabaseConnectionBudget,
} from "../../lib/desktop/runtime-limits";

describe("desktop PostgreSQL connection budget", () => {
  it("preserves the specified web pool and at least five maintenance slots", () => {
    const budget = desktopDatabaseConnectionBudget();

    expect(DESKTOP_DATABASE_LIMITS.webPoolMax).toBe(8);
    expect(DESKTOP_DATABASE_LIMITS.workerConcurrency).toBe(2);
    expect(budget.allocated).toBeLessThanOrEqual(
      DESKTOP_DATABASE_LIMITS.postgresMaxConnections,
    );
    expect(budget.headroom).toBeGreaterThanOrEqual(
      DESKTOP_DATABASE_LIMITS.requiredMaintenanceHeadroom,
    );
  });
});
