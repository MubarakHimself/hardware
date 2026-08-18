export const DESKTOP_DATABASE_LIMITS = {
  postgresMaxConnections: 20,
  webPoolMax: 8,
  workerApplicationPoolMax: 3,
  graphileWorkerPoolMax: 4,
  workerConcurrency: 2,
  requiredMaintenanceHeadroom: 5,
} as const;

export function desktopDatabaseConnectionBudget(): {
  allocated: number;
  headroom: number;
} {
  const allocated =
    DESKTOP_DATABASE_LIMITS.webPoolMax +
    DESKTOP_DATABASE_LIMITS.workerApplicationPoolMax +
    DESKTOP_DATABASE_LIMITS.graphileWorkerPoolMax;
  return {
    allocated,
    headroom:
      DESKTOP_DATABASE_LIMITS.postgresMaxConnections - allocated,
  };
}
