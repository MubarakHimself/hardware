import { randomBytes } from "node:crypto";
import path from "node:path";
import { DESKTOP_DATABASE_LIMITS } from "../lib/desktop/runtime-limits";
import type {
  BackupRestoreHooks,
  BackupService,
} from "./backup";
import { RuntimeJournal } from "./journal";
import type { DesktopLogger } from "./logger";
import { safeError, silentLogger } from "./logger";
import type { RuntimePaths } from "./paths";
import type { PostgresConnection, PostgresManager } from "./postgres";
import { CommandRunner } from "./process-supervisor";
import { reserveLoopbackPort, waitForCondition } from "./probes";
import type { ProviderCredentialService } from "./providers";
import type { DesktopRuntimeApi } from "./runtime-api";
import {
  postgresExecutable,
  type RuntimeLayout,
  validateRuntimeLayout,
} from "./runtime-layout";
import type { RuntimeLock } from "./runtime-lock";
import type { DesktopSettingsStore } from "./settings";
import type {
  ActiveWork,
  BackupResult,
  RestoreResult,
  RuntimeStage,
  RuntimeStatus,
} from "./types";
import { publicRuntimePhase } from "./types";
import {
  ManagedUtilityProcess,
  UtilityCommandRunner,
  type UtilityProcessAdapter,
} from "./utility-process";
import type { CredentialVault } from "./vault";
import { VaultLockedError } from "./vault";

interface RuntimeEnvironment {
  databaseUrl: string;
  providers: {
    YOUTUBE_API_KEY?: string;
    GITHUB_TOKEN?: string;
  };
}

export class DesktopRuntime {
  readonly #paths: RuntimePaths;
  readonly #layout: RuntimeLayout;
  readonly #settings: DesktopSettingsStore;
  readonly #vault: CredentialVault;
  readonly #postgres: PostgresManager;
  readonly #nativeRunner: CommandRunner;
  readonly #api: DesktopRuntimeApi;
  readonly #lock: RuntimeLock;
  readonly #journal: RuntimeJournal;
  readonly #sessionToken: string;
  readonly #appVersion: string;
  readonly #release: string;
  readonly #utilityHostPath: string;
  readonly #utilityAdapter: UtilityProcessAdapter;
  readonly #utilityRunner: UtilityCommandRunner;
  readonly #logger: DesktopLogger;
  readonly #onOriginChanged?: (origin: string) => void;
  readonly #listeners = new Set<(status: RuntimeStatus) => void>();
  #providers?: ProviderCredentialService;
  #backup?: BackupService;
  #worker?: ManagedUtilityProcess;
  #web?: ManagedUtilityProcess;
  #connection?: PostgresConnection;
  #webPort?: number;
  #locked = false;
  #loaded = false;
  #startPromise?: Promise<void>;
  #stopPromise?: Promise<void>;
  #startupAbort?: AbortController;
  #status: RuntimeStatus = {
    phase: "idle",
    ready: false,
    detail: "Hardware is not running.",
    database: "stopped",
    worker: "stopped",
    web: "stopped",
  };

  constructor(options: {
    paths: RuntimePaths;
    layout: RuntimeLayout;
    settings: DesktopSettingsStore;
    vault: CredentialVault;
    postgres: PostgresManager;
    runner: CommandRunner;
    api: DesktopRuntimeApi;
    lock: RuntimeLock;
    sessionToken: string;
    appVersion: string;
    release?: string;
    utilityHostPath: string;
    utilityAdapter: UtilityProcessAdapter;
    logger?: DesktopLogger;
    onOriginChanged?: (origin: string) => void;
  }) {
    this.#paths = options.paths;
    this.#layout = options.layout;
    this.#settings = options.settings;
    this.#vault = options.vault;
    this.#postgres = options.postgres;
    this.#nativeRunner = options.runner;
    this.#api = options.api;
    this.#lock = options.lock;
    this.#journal = new RuntimeJournal(options.paths.operationJournal);
    this.#sessionToken = options.sessionToken;
    this.#appVersion = options.appVersion;
    this.#release = options.release ?? options.appVersion;
    this.#utilityHostPath = options.utilityHostPath;
    this.#utilityAdapter = options.utilityAdapter;
    this.#logger = options.logger ?? silentLogger;
    this.#utilityRunner = new UtilityCommandRunner({
      adapter: this.#utilityAdapter,
      hostModule: this.#utilityHostPath,
      logger: this.#logger,
    });
    this.#onOriginChanged = options.onOriginChanged;
  }

  setProviderService(providers: ProviderCredentialService): void {
    this.#providers = providers;
  }

  setBackupService(backup: BackupService): void {
    this.#backup = backup;
  }

  get status(): RuntimeStatus {
    return structuredClone(this.#status);
  }

  get origin(): string | undefined {
    return this.#api.origin;
  }

  get backupBusy(): boolean {
    return Boolean(this.#backup?.busy);
  }

  onStatus(listener: (status: RuntimeStatus) => void): () => void {
    this.#listeners.add(listener);
    listener(this.status);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#status.ready) return;
    if (this.#startPromise) return this.#startPromise;
    if (this.#stopPromise) await this.#stopPromise;
    const abort = new AbortController();
    this.#startupAbort = abort;
    const startup = this.#startInternal(abort.signal).finally(() => {
      if (this.#startupAbort === abort) this.#startupAbort = undefined;
      if (this.#startPromise === startup) this.#startPromise = undefined;
    });
    this.#startPromise = startup;
    return startup;
  }

  async retry(): Promise<void> {
    await this.stop({ clean: false, releaseLock: false });
    await this.start();
  }

  async restart(): Promise<void> {
    // Credential changes are intentional restarts, not interrupted recovery.
    await this.stop({ clean: true, releaseLock: false });
    await this.start();
  }

  async activeWork(): Promise<ActiveWork> {
    if (!this.#status.ready) {
      return { queued: 0, running: 0, total: 0, byType: [] };
    }
    const active = await this.#api.activeWork();
    this.#status = {
      ...this.#status,
      activeJobs: {
        queued: active.queued,
        running: active.running,
        total: active.total,
      },
    };
    this.#emit();
    return active;
  }

  async createBackup(): Promise<BackupResult> {
    if (!this.#backup || !this.#connection) {
      throw new Error("The database is not available for backup.");
    }
    return this.#backup.create(this.#connection);
  }

  async restoreBackup(
    archivePath: string,
    recoveryKeyFile?: string,
  ): Promise<RestoreResult> {
    if (!this.#backup || !this.#connection) {
      throw new Error("The database is not available for restore.");
    }
    return this.#backup.restore(
      archivePath,
      this.#connection,
      this.#restoreHooks(),
      recoveryKeyFile,
    );
  }

  async stop(
    options: { clean?: boolean; releaseLock?: boolean } = {},
  ): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    const shutdown = this.#stopInternal({
      clean: options.clean ?? true,
      releaseLock: options.releaseLock ?? false,
    }).finally(() => {
      if (this.#stopPromise === shutdown) this.#stopPromise = undefined;
    });
    this.#stopPromise = shutdown;
    return shutdown;
  }

  async dispose(): Promise<void> {
    await this.stop({ clean: true, releaseLock: true });
    this.#vault.lock();
  }

  async #startInternal(signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      this.#transition("preparing", "Preparing local Hardware services.");
      if (!this.#loaded) {
        await this.#settings.load();
        await this.#vault.load();
        this.#loaded = true;
      }
      if (!this.#locked) {
        await this.#lock.acquire();
        this.#locked = true;
      }
      if (this.#vault.locked) {
        this.#transition(
          "unlocking_vault",
          "Unlock the local credential vault to continue.",
        );
        throw new VaultLockedError();
      }
      await validateRuntimeLayout(this.#layout);
      signal.throwIfAborted();
      const interrupted = await this.#journal.readInterruptedOperation();
      await this.#journal.begin("preparing");
      await this.#settings.update({ lastCleanShutdown: false });

      const databasePassword = await this.#databasePassword();
      this.#transition("starting_database", "Starting the local database.", {
        database: "starting",
      });
      await this.#journal.transition("starting_database");
      const freshDatabase = await this.#postgres.initialize(databasePassword);
      const databasePort = await reserveLoopbackPort();
      this.#connection = await this.#postgres.start(
        databasePort,
        databasePassword,
      );
      signal.throwIfAborted();
      this.#transition("starting_database", "Local database is ready.", {
        database: "ready",
      });

      const settings = this.#settings.snapshot();
      const versionChanged =
        Boolean(settings.lastSuccessfulVersion) &&
        settings.lastSuccessfulVersion !== this.#appVersion;
      const needsBackup =
        !freshDatabase &&
        Boolean(this.#backup) &&
        (Boolean(interrupted) ||
          versionChanged ||
          (await this.#backup!.isStale()));
      let safetyBackup: BackupResult | undefined;
      if (needsBackup && this.#backup) {
        this.#transition(
          "backing_up",
          versionChanged
            ? "Creating a safety backup before updating."
            : "Creating the scheduled safety backup.",
        );
        await this.#journal.transition("backing_up");
        safetyBackup = await this.#backup.create(this.#connection);
        signal.throwIfAborted();
      }

      this.#webPort = await reserveLoopbackPort();
      const origin = `http://127.0.0.1:${this.#webPort}`;
      this.#api.setOrigin(origin);
      this.#onOriginChanged?.(origin);

      if (versionChanged) {
        if (!this.#backup || !safetyBackup) {
          throw new Error(
            "Hardware cannot stage this update without a verified backup.",
          );
        }
        this.#transition(
          "migrating",
          "Validating this update against a staged copy of your library.",
        );
        await this.#journal.transition("migrating");
        await this.#backup.restore(
          path.join(this.#backup.directory, safetyBackup.displayName),
          this.#connection,
          this.#restoreHooks(signal),
        );
      } else {
        this.#transition("migrating", "Updating the local database.");
        await this.#journal.transition("migrating");
        await this.#runMigrations(this.#connection.url, signal);
        signal.throwIfAborted();
        await this.#startConsumers(
          await this.#environment(this.#connection.url),
          origin,
        );
        this.#transition(
          "checking_readiness",
          "Checking the local catalog and background worker.",
        );
        await this.#journal.transition("checking_readiness");
        await waitForCondition(() => this.#api.isReady(), {
          timeoutMs: 60_000,
          intervalMs: 500,
          signal,
        });
      }
      signal.throwIfAborted();
      this.#transition("ready", "Hardware is ready.", {
        database: "ready",
        worker: "ready",
        web: "ready",
      });
      await this.#journal.transition("ready");
      await this.#settings.update({
        lastSuccessfulVersion: this.#appVersion,
      });
      this.#monitorProcess(this.#worker, "worker");
      this.#monitorProcess(this.#web, "web");
    } catch (error) {
      this.#logger.error({
        event: "desktop_start_failed",
        ...safeError(error),
      });
      if (!(error instanceof VaultLockedError)) {
        await this.#stopConsumers().catch(() => undefined);
      }
      this.#status = {
        ...this.#status,
        phase: "recovery",
        ready: false,
        detail:
          error instanceof VaultLockedError
            ? error.message
            : signal.aborted
              ? "Hardware startup was stopped safely."
              : "Hardware could not start. Retry, restore a backup, or open the logs.",
        worker: "stopped",
        web: "stopped",
      };
      this.#emit();
      throw error;
    }
  }

  async #startConsumers(
    runtime: RuntimeEnvironment,
    origin: string,
  ): Promise<void> {
    const common = this.#serviceEnvironment(
      runtime.databaseUrl,
      runtime.providers,
      origin,
    );
    this.#transition("starting_worker", "Starting background jobs.", {
      worker: "starting",
    });
    await this.#journal.transition("starting_worker");
    this.#worker = this.#managedUtility(
      "Graphile Worker",
      this.#layout.workerEntry,
      this.#layout.root,
      {
        ...common,
        SERVICE_NAME: "hardware-worker",
        DATABASE_POOL_MAX: String(
          DESKTOP_DATABASE_LIMITS.workerApplicationPoolMax,
        ),
        GRAPHILE_POOL_MAX: String(
          DESKTOP_DATABASE_LIMITS.graphileWorkerPoolMax,
        ),
        WORKER_CONCURRENCY: String(
          DESKTOP_DATABASE_LIMITS.workerConcurrency,
        ),
      },
    );
    await this.#worker.start();

    this.#transition("starting_web", "Starting the Hardware interface.", {
      worker: "ready",
      web: "starting",
    });
    await this.#journal.transition("starting_web");
    this.#web = this.#managedUtility(
      "Next.js",
      this.#layout.serverEntry,
      this.#layout.root,
      {
        ...common,
        SERVICE_NAME: "hardware-web",
        DATABASE_POOL_MAX: String(
          DESKTOP_DATABASE_LIMITS.webPoolMax,
        ),
        PORT: String(this.#webPort),
        HOSTNAME: "127.0.0.1",
      },
    );
    await this.#web.start();
  }

  async #stopConsumers(): Promise<void> {
    if (this.#web?.running && this.#api.origin) {
      await this.#api.setDraining(true).catch(() => undefined);
    }
    await this.#worker?.stop();
    this.#worker = undefined;
    await this.#web?.stop();
    this.#web = undefined;
  }

  async #stopInternal(options: {
    clean: boolean;
    releaseLock: boolean;
  }): Promise<void> {
    this.#startupAbort?.abort(
      new Error("Hardware startup was cancelled for shutdown."),
    );
    const startup = this.#startPromise;
    if (startup) await startup.catch(() => undefined);
    if (
      this.#status.phase === "idle" &&
      !this.#connection &&
      !this.#locked
    ) {
      return;
    }
    this.#transition("draining", "Finishing local requests.");
    await this.#journal.transition("draining").catch(() => undefined);
    await this.#stopConsumers();
    this.#transition("stopping", "Stopping the local database.", {
      worker: "stopped",
      web: "stopped",
    });
    await this.#journal.transition("stopping").catch(() => undefined);
    await this.#postgres.stop();
    this.#connection = undefined;
    this.#webPort = undefined;
    if (options.clean) {
      await this.#settings.update({ lastCleanShutdown: true });
      await this.#journal.clear();
    }
    if (options.releaseLock && this.#locked) {
      await this.#lock.release();
      this.#locked = false;
    }
    this.#status = {
      phase: "idle",
      ready: false,
      detail: "Hardware is stopped.",
      database: "stopped",
      worker: "stopped",
      web: "stopped",
    };
    this.#emit();
  }

  async #databasePassword(): Promise<string> {
    const existing = await this.#vault.get("database:password");
    if (existing) return existing;
    const password = randomBytes(32).toString("base64url");
    await this.#vault.set("database:password", password);
    return password;
  }

  async #environment(databaseUrl: string): Promise<RuntimeEnvironment> {
    return {
      databaseUrl,
      providers: (await this.#providers?.environment()) ?? {},
    };
  }

  #serviceEnvironment(
    databaseUrl: string,
    providers: {
      YOUTUBE_API_KEY?: string;
      GITHUB_TOKEN?: string;
    },
    origin: string,
  ): Record<string, string> {
    return {
      ...inheritedOsEnvironment(),
      NODE_ENV: "production",
      APP_MODE: "local",
      NEXT_PUBLIC_APP_URL: origin,
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: String(DESKTOP_DATABASE_LIMITS.webPoolMax),
      DATABASE_SSL: "false",
      DATABASE_STATEMENT_TIMEOUT_MS: "15000",
      HEALTHCHECK_TOKEN: this.#sessionToken,
      DESKTOP_SESSION_TOKEN: this.#sessionToken,
      HARDWARE_DESKTOP: "1",
      RELEASE_SHA: this.#release,
      SOURCE_HTTP_TIMEOUT_MS: "10000",
      LOG_LEVEL: safeLogLevel(process.env.LOG_LEVEL),
      YOUTUBE_API_KEY: providers.YOUTUBE_API_KEY ?? "",
      GITHUB_TOKEN: providers.GITHUB_TOKEN ?? "",
    };
  }

  #migrationEnvironment(
    databaseUrl: string,
    origin: string,
  ): Record<string, string> {
    return {
      ...inheritedOsEnvironment(),
      NODE_ENV: "production",
      APP_MODE: "local",
      NEXT_PUBLIC_APP_URL: origin,
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: "2",
      DATABASE_SSL: "false",
      DATABASE_STATEMENT_TIMEOUT_MS: "120000",
      HARDWARE_DESKTOP: "1",
      RELEASE_SHA: this.#release,
    };
  }

  async #runMigrations(
    databaseUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const origin =
      this.#api.origin ??
      `http://127.0.0.1:${this.#webPort ?? 3000}`;
    await this.#utilityRunner.run({
      name: "Hardware database migrations",
      targetModule: this.#layout.migrationEntry,
      cwd: path.dirname(this.#layout.drizzleDirectory),
      environment: this.#migrationEnvironment(databaseUrl, origin),
      timeoutMs: 120_000,
      signal,
    });
  }

  async #validateStaging(databaseUrl: string): Promise<void> {
    const parsed = new URL(databaseUrl);
    await waitForCondition(
      async () => {
        const result = await this.#nativeRunner.run({
          name: "Restored catalog validation",
          executable: postgresExecutable(this.#layout, "psql"),
          args: [
            "--host",
            "127.0.0.1",
            "--port",
            parsed.port,
            "--username",
            decodeURIComponent(parsed.username),
            "--dbname",
            decodeURIComponent(parsed.pathname.slice(1)),
            "--tuples-only",
            "--no-align",
            "--command",
            `select case when
               to_regclass('public.projects') is not null
               and to_regclass('public.worker_heartbeats') is not null
               and to_regclass('graphile_worker.jobs') is not null
               and exists (
                 select 1 from pg_extension where extname = 'pg_trgm'
               )
             then 1 else 0 end`,
          ],
          cwd: this.#paths.runtime,
          environment: {
            ...inheritedOsEnvironment(),
            NODE_ENV: "production",
            PGPASSWORD: decodeURIComponent(parsed.password),
          },
          timeoutMs: 10_000,
        });
        return result.stdout.trim() === "1";
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );
  }

  #restoreHooks(signal?: AbortSignal): BackupRestoreHooks {
    return {
      migrateStaging: (databaseUrl) =>
        this.#runMigrations(databaseUrl, signal),
      validateStaging: (databaseUrl) =>
        this.#validateStaging(databaseUrl),
      stopConsumers: async () => {
        this.#transition("draining", "Stopping services for restore.");
        await this.#stopConsumers();
      },
      startConsumers: async () => {
        if (!this.#connection || !this.#webPort) {
          throw new Error("The local runtime cannot resume after restore.");
        }
        const origin = `http://127.0.0.1:${this.#webPort}`;
        await this.#startConsumers(
          await this.#environment(this.#connection.url),
          origin,
        );
        await waitForCondition(() => this.#api.isReady(), {
          timeoutMs: 60_000,
          intervalMs: 500,
          signal,
        });
        this.#transition("ready", "Hardware is ready.", {
          database: "ready",
          worker: "ready",
          web: "ready",
        });
      },
    };
  }

  #managedUtility(
    name: string,
    targetModule: string,
    cwd: string,
    environment: Record<string, string>,
  ): ManagedUtilityProcess {
    return new ManagedUtilityProcess(
      {
        name,
        hostModule: this.#utilityHostPath,
        targetModule,
        cwd,
        environment,
        stopTimeoutMs: 15_000,
      },
      { adapter: this.#utilityAdapter, logger: this.#logger },
    );
  }

  #monitorProcess(
    child: ManagedUtilityProcess | undefined,
    component: "worker" | "web",
  ): void {
    if (!child) return;
    void child.waitForExit().then(({ code }) => {
      if (!this.#status.ready || this.#status.phase === "stopping") return;
      this.#logger.error({
        event: "runtime_process_exited",
        process: component,
        exitCode: code,
      });
      this.#status = {
        ...this.#status,
        phase: "recovery",
        ready: false,
        detail: `The ${component} service stopped unexpectedly.`,
        [component]: "failed",
      };
      this.#emit();
    });
  }

  #transition(
    stage: RuntimeStage,
    detail: string,
    components: Partial<
      Pick<RuntimeStatus, "database" | "worker" | "web">
    > = {},
  ): void {
    this.#status = {
      ...this.#status,
      phase: publicRuntimePhase(stage),
      ready: stage === "ready",
      detail,
      ...components,
    };
    this.#emit();
  }

  #emit(): void {
    const snapshot = this.status;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

const SERVICE_ENVIRONMENT_ALLOWLIST = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
] as const;

export function inheritedOsEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of SERVICE_ENVIRONMENT_ALLOWLIST) {
    const value = environment[key];
    if (value) inherited[key] = value;
  }
  return inherited;
}

function safeLogLevel(value: string | undefined): string {
  return ["fatal", "error", "warn", "info", "debug", "trace"].includes(
    value ?? "",
  )
    ? value!
    : "info";
}
