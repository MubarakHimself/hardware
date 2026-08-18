import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DesktopLogger } from "./logger";
import { safeError, silentLogger } from "./logger";
import type { RuntimePaths } from "./paths";
import {
  CommandRunner,
  ManagedProcess,
  type SpawnAdapter,
} from "./process-supervisor";
import { canConnectToLoopback, waitForCondition } from "./probes";
import { DESKTOP_DATABASE_LIMITS } from "../lib/desktop/runtime-limits";
import {
  postgresExecutable,
  type RuntimeLayout,
} from "./runtime-layout";
import { isProcessAlive } from "./runtime-lock";

export interface PostgresConnection {
  host: "127.0.0.1";
  port: number;
  user: "hardware";
  password: string;
  database: "hardware";
  url: string;
}

export class PostgresManager {
  readonly #paths: RuntimePaths;
  readonly #layout: RuntimeLayout;
  readonly #runner: CommandRunner;
  readonly #spawnAdapter?: SpawnAdapter;
  readonly #logger: DesktopLogger;
  #process?: ManagedProcess;
  #initializedThisRun = false;
  #connection?: PostgresConnection;

  constructor(options: {
    paths: RuntimePaths;
    layout: RuntimeLayout;
    runner: CommandRunner;
    spawnAdapter?: SpawnAdapter;
    logger?: DesktopLogger;
  }) {
    this.#paths = options.paths;
    this.#layout = options.layout;
    this.#runner = options.runner;
    this.#spawnAdapter = options.spawnAdapter;
    this.#logger = options.logger ?? silentLogger;
  }

  get connection(): PostgresConnection | undefined {
    return this.#connection;
  }

  async initialize(password: string): Promise<boolean> {
    try {
      await readFile(path.join(this.#paths.postgresData, "PG_VERSION"), "utf8");
      this.#initializedThisRun = false;
      return false;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
    }

    await this.#runner.run({
      name: "PostgreSQL initialization",
      executable: postgresExecutable(this.#layout, "initdb"),
      args: [
        "--pgdata",
        this.#paths.postgresData,
        "--username",
        "hardware",
        "--encoding",
        "UTF8",
        "--locale",
        "C",
        "--auth-host",
        "scram-sha-256",
        "--auth-local",
        "scram-sha-256",
        "--data-checksums",
        "--pwfile=-",
      ],
      cwd: this.#paths.runtime,
      environment: {
        ...process.env,
        PGDATA: this.#paths.postgresData,
      },
      stdin: `${password}\n`,
      timeoutMs: 60_000,
    });
    this.#initializedThisRun = true;
    return true;
  }

  async reconcileOrphan(): Promise<void> {
    const pidFile = path.join(this.#paths.postgresData, "postmaster.pid");
    let pid: number | undefined;
    let recordedDataDirectory: string | undefined;
    try {
      const lines = (await readFile(pidFile, "utf8")).split(/\r?\n/);
      const parsed = Number(lines[0]);
      if (Number.isSafeInteger(parsed) && parsed > 0) pid = parsed;
      recordedDataDirectory = lines[1]?.trim();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    if (!pid) {
      throw new Error("PostgreSQL left an invalid recovery lock.");
    }
    if (isProcessAlive(pid)) {
      if (
        !recordedDataDirectory ||
        path.resolve(recordedDataDirectory) !==
          path.resolve(this.#paths.postgresData)
      ) {
        throw new Error(
          "A live process owns an unexpected PostgreSQL recovery lock.",
        );
      }
      const optionsFile = path.join(
        this.#paths.postgresData,
        "postmaster.opts",
      );
      const processOptions = await readFile(optionsFile, "utf8").catch(
        () => "",
      );
      const expectedExecutable = path
        .basename(postgresExecutable(this.#layout, "postgres"))
        .toLowerCase();
      if (!processOptions.toLowerCase().includes(expectedExecutable)) {
        throw new Error(
          "The recovery lock does not identify Hardware's PostgreSQL runtime.",
        );
      }
      this.#logger.warn(
        { event: "postgres_orphan_detected", pid },
        "Stopping a PostgreSQL process left by the previous Hardware session",
      );
      await this.#runner
        .run({
          name: "PostgreSQL orphan shutdown",
          executable: postgresExecutable(this.#layout, "pg_ctl"),
          args: [
            "--pgdata",
            this.#paths.postgresData,
            "stop",
            "--mode",
            "fast",
            "--wait",
            "--timeout",
            "30",
          ],
          cwd: this.#paths.runtime,
          timeoutMs: 35_000,
        })
        .catch((error) => {
          this.#logger.error({
            event: "postgres_orphan_stop_failed",
            ...safeError(error),
          });
          throw error;
        });
      return;
    }
    await rm(pidFile, { force: true });
  }

  async start(port: number, password: string): Promise<PostgresConnection> {
    if (this.#process?.running && this.#connection) return this.#connection;
    await this.reconcileOrphan();
    const connection: PostgresConnection = {
      host: "127.0.0.1",
      port,
      user: "hardware",
      password,
      database: "hardware",
      url: postgresUrl("hardware", password, port, "hardware"),
    };
    const postgres = new ManagedProcess(
      {
        name: "PostgreSQL",
        executable: postgresExecutable(this.#layout, "postgres"),
        args: [
          "-D",
          this.#paths.postgresData,
          "-h",
          "127.0.0.1",
          "-p",
          String(port),
          "-c",
          `max_connections=${DESKTOP_DATABASE_LIMITS.postgresMaxConnections}`,
          "-c",
          "shared_buffers=64MB",
          "-c",
          "fsync=on",
          "-c",
          "full_page_writes=on",
          "-c",
          "password_encryption=scram-sha-256",
          "-c",
          "ssl=off",
          "-c",
          "unix_socket_directories=",
          "-c",
          "logging_collector=on",
          "-c",
          `log_directory=${this.#paths.logs}`,
          "-c",
          "log_filename=postgresql.log",
          "-c",
          "log_rotation_age=1440",
          "-c",
          "log_truncate_on_rotation=on",
        ],
        cwd: this.#paths.runtime,
        environment: {
          ...process.env,
          PGDATA: this.#paths.postgresData,
        },
        stopTimeoutMs: 10_000,
      },
      {
        ...(this.#spawnAdapter
          ? { spawnAdapter: this.#spawnAdapter }
          : {}),
        logger: this.#logger,
      },
    );
    await postgres.start();
    this.#process = postgres;
    this.#connection = connection;
    try {
      await waitForCondition(() => canConnectToLoopback(port), {
        timeoutMs: 30_000,
        intervalMs: 250,
      });
      const databaseExists = await this.#runner.run({
        name: "Hardware database check",
        executable: postgresExecutable(this.#layout, "psql"),
        args: [
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--username",
          "hardware",
          "--dbname",
          "postgres",
          "--tuples-only",
          "--no-align",
          "--command",
          "select 1 from pg_database where datname = 'hardware'",
        ],
        cwd: this.#paths.runtime,
        environment: {
          ...process.env,
          PGPASSWORD: password,
        },
        timeoutMs: 30_000,
      });
      if (databaseExists.stdout.trim() !== "1") {
        await this.#runner.run({
          name: "Hardware database creation",
          executable: postgresExecutable(this.#layout, "createdb"),
          args: [
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--username",
            "hardware",
            "hardware",
          ],
          cwd: this.#paths.runtime,
          environment: {
            ...process.env,
            PGPASSWORD: password,
          },
          timeoutMs: 30_000,
        });
      }
      return connection;
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.#process?.running) {
      this.#process = undefined;
      this.#connection = undefined;
      return;
    }
    try {
      await this.#runner.run({
        name: "PostgreSQL shutdown",
        executable: postgresExecutable(this.#layout, "pg_ctl"),
        args: [
          "--pgdata",
          this.#paths.postgresData,
          "stop",
          "--mode",
          "fast",
          "--wait",
          "--timeout",
          "30",
        ],
        cwd: this.#paths.runtime,
        timeoutMs: 35_000,
      });
      await Promise.race([
        this.#process.waitForExit(),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch (error) {
      this.#logger.warn({
        event: "postgres_graceful_stop_failed",
        ...safeError(error),
      });
      await this.#process.stop("SIGTERM");
    } finally {
      this.#process = undefined;
      this.#connection = undefined;
    }
  }
}

export function postgresUrl(
  user: string,
  password: string,
  port: number,
  database: string,
): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}
