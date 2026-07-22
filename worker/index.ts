import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { run } from "graphile-worker";
import { z } from "zod";
import { closeDatabase, getPool } from "../db/index";
import { createTaskList } from "./tasks";
import { createRuntimeTaskImplementations } from "./implementations/runtime";
import { logger, safeErrorDetails } from "./logger";

const environmentSchema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  RELEASE_SHA: z.string().min(1).default("development"),
});

const env = environmentSchema.parse(process.env);
const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const startedAt = new Date();

async function writeHeartbeat(): Promise<void> {
  await getPool().query(
    `
      insert into worker_heartbeats (
        worker_id,
        version,
        started_at,
        last_seen_at,
        details
      ) values ($1, $2, $3, now(), $4::jsonb)
      on conflict (worker_id) do update
      set last_seen_at = excluded.last_seen_at,
          version = excluded.version,
          details = excluded.details
    `,
    [
      workerId,
      env.RELEASE_SHA,
      startedAt,
      JSON.stringify({ concurrency: env.WORKER_CONCURRENCY }),
    ],
  );
}

async function main(): Promise<void> {
  const taskImplementations = createRuntimeTaskImplementations();
  await writeHeartbeat();
  const heartbeat = setInterval(() => {
    void writeHeartbeat().catch((error: unknown) => {
      logger.error({ event: "heartbeat_failed", ...safeErrorDetails(error) });
    });
  }, 15_000);
  heartbeat.unref();

  const runner = await run({
    connectionString: env.DATABASE_URL,
    concurrency: env.WORKER_CONCURRENCY,
    crontabFile: fileURLToPath(new URL("./crontab", import.meta.url)),
    noHandleSignals: true,
    taskList: createTaskList(taskImplementations),
  });

  logger.info({
    event: "worker_started",
    workerId,
    concurrency: env.WORKER_CONCURRENCY,
  });

  let stopPromise: Promise<void> | undefined;
  const stop = (signal: string): Promise<void> => {
    stopPromise ??= (async () => {
      clearInterval(heartbeat);
      logger.info({ event: "worker_stopping", signal, workerId });
      await runner.stop();
      await getPool()
        .query("delete from worker_heartbeats where worker_id = $1", [workerId])
        .catch(() => undefined);
      await closeDatabase();
    })();
    return stopPromise;
  };

  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  await runner.promise;
  await stop("runner_completed");
}

main().catch(async (error: unknown) => {
  logger.fatal({ event: "worker_start_failed", ...safeErrorDetails(error) });
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
