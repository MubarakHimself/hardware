import type { ChannelSyncFrequency } from "./contracts";

/**
 * Computes the next automatic sync without resetting a healthy schedule.
 * Overdue sources are due immediately; a source that has never synced is also
 * due immediately. Manual sources never receive an automatic due date.
 */
export function calculateNextChannelSyncAt(
  frequency: ChannelSyncFrequency,
  lastSyncedAt: Date | null,
  now = new Date(),
): Date | null {
  if (frequency === "manual") return null;
  if (!lastSyncedAt) return new Date(now);

  const intervalMs = frequency === "weekly"
    ? 7 * 24 * 60 * 60 * 1_000
    : 24 * 60 * 60 * 1_000;
  const calculatedDueAt = new Date(lastSyncedAt.getTime() + intervalMs);
  return calculatedDueAt.getTime() <= now.getTime()
    ? new Date(now)
    : calculatedDueAt;
}
