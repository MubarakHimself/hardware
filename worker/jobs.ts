import { z } from "zod";

export const trackedJobPayloadSchema = z
  .object({
    jobId: z.uuid(),
    correlationId: z.uuid(),
  })
  .loose();

export type TrackedJobPayload = z.infer<typeof trackedJobPayloadSchema>;

export const taskNames = [
  "channel_resolve",
  "channel_backfill",
  "channel_poll",
  "video_ingest",
  "youtube_revalidate",
  "website_metadata",
  "repository_resolve",
  "repository_refresh",
] as const;

export type TaskName = (typeof taskNames)[number];

export class SafeJobError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = "SafeJobError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function safeJobError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof SafeJobError) {
    return {
      code: error.code,
      message: error.message.slice(0, 500),
      retryable: error.retryable,
    };
  }

  return {
    code: "JOB_EXECUTION_FAILED",
    message: "The job failed. Review structured server logs for the correlation ID.",
    retryable: true,
  };
}
