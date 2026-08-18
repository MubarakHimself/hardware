import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
} from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BackupService } from "./backup";
import { createBootstrapPage } from "./bootstrap-page";
import { BOOTSTRAP_URL } from "./channels";
import {
  registerDesktopIpc,
  sendNativeOperationProgress,
  sendRuntimeStatus,
} from "./ipc";
import { createFileLogger, safeError } from "./logger";
import {
  ensureRuntimePaths,
  resolveRuntimePaths,
  validateEraseTarget,
} from "./paths";
import { PostgresManager } from "./postgres";
import { CommandRunner } from "./process-supervisor";
import { ProviderCredentialService } from "./providers";
import {
  NativeOperationConflictError,
  NativeOperationCoordinator,
} from "./operation-coordinator";
import { DesktopRuntime } from "./runtime";
import { DesktopRuntimeApi } from "./runtime-api";
import {
  readSchemaVersion,
  resolveRuntimeLayout,
} from "./runtime-layout";
import { RuntimeLock } from "./runtime-lock";
import {
  installSessionSecurity,
  secureBrowserWindow,
} from "./security";
import { DesktopSettingsStore } from "./settings";
import type { DesktopAppInfo } from "./types";
import type { UtilityProcessAdapter } from "./utility-process";
import { CredentialVault } from "./vault";
import { clampWindowBounds } from "./window-state";

const RELEASES_URL =
  "https://github.com/MubarakHimself/hardware/releases";
const ERASE_ARGUMENT_PREFIX = "--hardware-finalize-erase=";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "hardware",
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: false,
      supportFetchAPI: false,
      corsEnabled: false,
      stream: true,
    },
  },
]);

const earlyPaths = resolveRuntimePaths({
  homeDirectory: homedir(),
  documentsDirectory: path.join(homedir(), "Documents"),
});
const pendingEraseToken = eraseTokenFromArguments();
app.setPath(
  "userData",
  pendingEraseToken
    ? path.join(tmpdir(), `hardware-eraser-${pendingEraseToken}`)
    : path.join(earlyPaths.runtime, "electron"),
);
app.setAppUserModelId("com.mubarak.hardware");

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
  app.quit();
} else {
  void runDesktop().catch((error: unknown) => {
    const detail =
      error instanceof Error ? error.message : "Unknown startup failure";
    console.error(`Hardware desktop failed: ${detail}`);
    app.exit(1);
  });
}

async function runDesktop(): Promise<void> {
  if (await completePendingErase(earlyPaths.profileRoots)) {
    app.relaunch({
      args: process.argv
        .slice(1)
        .filter(
          (argument) => !argument.startsWith(ERASE_ARGUMENT_PREFIX),
        ),
    });
    app.exit(0);
    return;
  }
  await ensureRuntimePaths(earlyPaths);
  const logger = createFileLogger(path.join(earlyPaths.logs, "desktop.log"), {
    service: "hardware-desktop",
    version: app.getVersion(),
  });
  let fatalCleanup: () => Promise<void> = async () => undefined;
  let fatalShutdownStarted = false;
  const handleFatalMainError = (
    event: "uncaught_exception" | "unhandled_rejection",
    error: unknown,
  ): void => {
    if (fatalShutdownStarted) return;
    fatalShutdownStarted = true;
    logger.error({ event, ...safeError(error) });
    void (async () => {
      await Promise.race([
        fatalCleanup().catch((cleanupError) => {
          logger.error({
            event: "fatal_cleanup_failed",
            ...safeError(cleanupError),
          });
        }),
        delay(5_000),
      ]);
      await logger.flush?.();
      app.exit(1);
    })();
  };
  process.once("uncaughtException", (error) =>
    handleFatalMainError("uncaught_exception", error),
  );
  process.once("unhandledRejection", (error) =>
    handleFatalMainError("unhandled_rejection", error),
  );

  app.setPath("crashDumps", earlyPaths.crashDumps);
  app.setAppLogsPath(earlyPaths.logs);
  crashReporter.start({
    productName: "Hardware",
    companyName: "Hardware",
    uploadToServer: false,
    compress: true,
  });

  await app.whenReady();
  const paths = resolveRuntimePaths({
    homeDirectory: homedir(),
    documentsDirectory: app.getPath("documents"),
  });
  await ensureRuntimePaths(paths);
  const settings = new DesktopSettingsStore(paths.settingsFile);
  await settings.load();
  const layout = resolveRuntimeLayout({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    applicationPath: app.getAppPath(),
    ...(!app.isPackaged && process.env.HARDWARE_POSTGRES_RUNTIME
      ? { postgresOverride: process.env.HARDWARE_POSTGRES_RUNTIME }
      : {}),
  });
  const schemaVersion = await readSchemaVersion(layout.drizzleDirectory);
  const launchToken = randomBytes(32).toString("base64url");
  let applicationOrigin: string | undefined;
  let hardwareWindow: BrowserWindow | undefined;
  let allowApplicationExit = false;
  let quitInProgress = false;
  let loadedTarget = "";

  const internalSession = session.fromPartition(
    "persist:hardware-internal",
    { cache: true },
  );
  await internalSession.protocol.handle("hardware", (request) => {
    const url = new URL(request.url);
    if (url.origin !== "hardware://bootstrap" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
    return new Response(createBootstrapPage(), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'",
      },
    });
  });
  installSessionSecurity({
    session: internalSession,
    sessionToken: launchToken,
    getApplicationOrigin: () => applicationOrigin,
    openExternal: (url) => shell.openExternal(url),
    logger,
  });

  const savedBounds = settings.snapshot().windowBounds;
  const defaultBounds = { x: 120, y: 90, width: 1280, height: 800 };
  const bounds = clampWindowBounds(
    savedBounds,
    screen.getAllDisplays().map((display) => ({
      workArea: display.workArea,
    })),
    defaultBounds,
  );
  const preloadPath = fileURLToPath(
    new URL("./preload.cjs", import.meta.url),
  );
  hardwareWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1024,
    minHeight: 720,
    title: "Hardware",
    backgroundColor: "#0e0e0c",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: internalSession,
      preload: preloadPath,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  secureBrowserWindow(hardwareWindow, {
    getApplicationOrigin: () => applicationOrigin,
    openExternal: (url) => shell.openExternal(url),
    logger,
  });
  hardwareWindow.once("ready-to-show", () => hardwareWindow?.show());

  const vault = new CredentialVault({
    file: paths.vaultFile,
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
      getSelectedStorageBackend: () =>
        safeStorage.getSelectedStorageBackend(),
    },
  });
  const nativeRunner = new CommandRunner({ logger });
  const postgres = new PostgresManager({
    paths,
    layout,
    runner: nativeRunner,
    logger,
  });
  const runtimeApi = new DesktopRuntimeApi({
    sessionToken: launchToken,
  });
  const utilityAdapter: UtilityProcessAdapter = {
    fork(modulePath, arguments_, options) {
      return utilityProcess.fork(modulePath, [...arguments_], {
        cwd: options.cwd,
        env: options.env,
        serviceName: options.serviceName,
        stdio: options.stdio,
      });
    },
  };
  const utilityHostPath = fileURLToPath(
    new URL("./utility-host.js", import.meta.url),
  );
  const runtime = new DesktopRuntime({
    paths,
    layout,
    settings,
    vault,
    postgres,
    runner: nativeRunner,
    api: runtimeApi,
    lock: new RuntimeLock(path.join(paths.runtime, "hardware.lock")),
    sessionToken: launchToken,
    appVersion: app.getVersion(),
    release: app.getVersion(),
    utilityHostPath,
    utilityAdapter,
    logger,
    onOriginChanged: (origin) => {
      applicationOrigin = origin;
    },
  });
  fatalCleanup = () => runtime.dispose();
  const providers = new ProviderCredentialService({
    vault,
    settings,
    onChanged: async () => runtime.restart(),
  });
  runtime.setProviderService(providers);
  const backup = new BackupService({
    paths,
    layout,
    settings,
    vault,
    appVersion: app.getVersion(),
    schemaVersion,
    logger,
    onProgress: (progress) =>
      sendNativeOperationProgress(hardwareWindow, progress),
  });
  runtime.setBackupService(backup);
  const operations = new NativeOperationCoordinator();

  const platform = requireSupportedPlatform(process.platform);
  const appInfo: DesktopAppInfo = {
    name: "Hardware",
    version: app.getVersion(),
    platform,
    architecture: process.arch,
    packaged: app.isPackaged,
    releasesUrl: RELEASES_URL,
  };

  const requestQuit = async (): Promise<void> => {
    try {
      if (
        quitInProgress ||
        allowApplicationExit ||
        operations.active === "lifecycle"
      ) {
        return;
      }
      await operations.run("lifecycle", async () => {
        const window = hardwareWindow;
        if (backup.busy) {
          if (window && !window.isDestroyed()) {
            await dialog.showMessageBox(window, {
              type: "info",
              title: "Backup or restore in progress",
              message:
                "Wait for the current backup or restore operation to finish before closing Hardware.",
            });
          }
          return;
        }
        let active: ActiveWorkSummary = {
          queued: 0,
          running: 0,
          total: 0,
        };
        try {
          active = await runtime.activeWork();
        } catch (error) {
          logger.warn({
            event: "active_work_check_failed",
            ...safeError(error),
          });
        }
        if (active.total > 0 && window && !window.isDestroyed()) {
          const decision = await dialog.showMessageBox(window, {
            type: "warning",
            title: "Work is still active",
            message: `${active.running} running and ${active.queued} queued job${active.total === 1 ? "" : "s"} will resume the next time Hardware opens.`,
            buttons: ["Keep Hardware open", "Quit anyway"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (decision.response !== 1) return;
        }
        quitInProgress = true;
        try {
          await saveWindowBounds(hardwareWindow, settings);
          await runtime.dispose();
          await logger.flush?.();
          allowApplicationExit = true;
          hardwareWindow?.destroy();
          app.quit();
        } catch (error) {
          quitInProgress = false;
          logger.error({
            event: "desktop_quit_failed",
            ...safeError(error),
          });
          await logger.flush?.();
          if (window && !window.isDestroyed()) {
            await dialog.showMessageBox(window, {
              type: "error",
              title: "Hardware could not close safely",
              message:
                "Hardware could not stop all local services. Open the logs for details, then try closing again.",
            });
          }
        }
      });
    } catch (error) {
      if (!(error instanceof NativeOperationConflictError)) throw error;
      const window = hardwareWindow;
      if (window && !window.isDestroyed()) {
        await dialog.showMessageBox(window, {
          type: "info",
          title: "Hardware is busy",
          message: error.message,
        });
      }
    }
  };

  const scheduleErase = async (
    confirmation: "ERASE",
  ): Promise<void> => {
    if (confirmation !== "ERASE") {
      throw new Error("Type ERASE to remove local Hardware data.");
    }
    if (backup.busy) {
      throw new Error(
        "Local data cannot be erased during a backup or restore.",
      );
    }
    await runtime.dispose();
    const token = randomUUID();
    const marker = eraseMarkerPath(token);
    await writeFile(
      marker,
      JSON.stringify({
        formatVersion: 1,
        confirmation: "ERASE",
        token,
        createdAt: new Date().toISOString(),
        targets: paths.profileRoots.map(validateEraseTarget),
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    allowApplicationExit = true;
    app.relaunch({
      args: [
        ...process.argv
          .slice(1)
          .filter((argument) => !argument.startsWith(ERASE_ARGUMENT_PREFIX)),
        `${ERASE_ARGUMENT_PREFIX}${token}`,
      ],
    });
    app.exit(0);
  };

  const disposeIpc = registerDesktopIpc({
    ipcMain,
    dialog,
    shell,
    getWindow: () => hardwareWindow,
    getApplicationOrigin: () => applicationOrigin,
    appInfo,
    releasesUrl: RELEASES_URL,
    paths,
    settings,
    vault,
    providers,
    backup,
    runtime,
    requestQuit,
    eraseAllLocalData: scheduleErase,
    operations,
  });

  await hardwareWindow.loadURL(BOOTSTRAP_URL);
  loadedTarget = BOOTSTRAP_URL;

  runtime.onStatus((status) => {
    sendRuntimeStatus(hardwareWindow, status);
    const target =
      status.ready && applicationOrigin
        ? applicationOrigin
        : status.phase === "recovery"
          ? BOOTSTRAP_URL
          : undefined;
    if (
      target &&
      loadedTarget !== target &&
      hardwareWindow &&
      !hardwareWindow.isDestroyed()
    ) {
      loadedTarget = target;
      void hardwareWindow.loadURL(target).catch((error) => {
        logger.error({
          event: "window_navigation_failed",
          ...safeError(error),
        });
      });
    }
  });

  hardwareWindow.on("close", (event) => {
    if (allowApplicationExit) return;
    event.preventDefault();
    void requestQuit();
  });
  app.on("before-quit", (event) => {
    if (allowApplicationExit) return;
    event.preventDefault();
    void requestQuit();
  });
  app.on("second-instance", () => {
    if (!hardwareWindow || hardwareWindow.isDestroyed()) return;
    if (hardwareWindow.isMinimized()) hardwareWindow.restore();
    hardwareWindow.show();
    hardwareWindow.focus();
  });
  app.on("window-all-closed", () => {
    if (!allowApplicationExit) void requestQuit();
  });
  app.once("will-quit", () => {
    disposeIpc();
    void internalSession.protocol.unhandle("hardware");
  });

  void runtime.start().catch(() => {
    // Runtime state already moved to the local recovery screen.
  });
}

interface ActiveWorkSummary {
  queued: number;
  running: number;
  total: number;
}

async function saveWindowBounds(
  window: BrowserWindow | undefined,
  settings: DesktopSettingsStore,
): Promise<void> {
  if (!window || window.isDestroyed() || window.isMinimized()) return;
  const bounds = window.getNormalBounds();
  await settings.update({ windowBounds: bounds });
}

function requireSupportedPlatform(
  platform: NodeJS.Platform,
): "win32" | "linux" {
  if (platform === "win32" || platform === "linux") return platform;
  throw new Error("This Hardware alpha supports Windows and Ubuntu only.");
}

function eraseMarkerPath(token: string): string {
  return path.join(tmpdir(), `hardware-erase-${token}.json`);
}

function eraseTokenFromArguments(): string | undefined {
  return process.argv
    .find((value) => value.startsWith(ERASE_ARGUMENT_PREFIX))
    ?.slice(ERASE_ARGUMENT_PREFIX.length);
}

async function completePendingErase(
  profileRoots: string[],
): Promise<boolean> {
  const token = eraseTokenFromArguments();
  if (!token) return false;
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    throw new Error("Invalid Hardware erase authorization.");
  }
  const marker = eraseMarkerPath(token);
  const parsed = JSON.parse(await readFile(marker, "utf8")) as {
    formatVersion?: unknown;
    confirmation?: unknown;
    token?: unknown;
    createdAt?: unknown;
    targets?: unknown;
  };
  const expectedTargets = profileRoots.map(validateEraseTarget).sort();
  const suppliedTargets = Array.isArray(parsed.targets)
    ? parsed.targets.map((value) => validateEraseTarget(String(value))).sort()
    : [];
  const age =
    typeof parsed.createdAt === "string"
      ? Date.now() - Date.parse(parsed.createdAt)
      : Number.POSITIVE_INFINITY;
  if (
    parsed.formatVersion !== 1 ||
    parsed.confirmation !== "ERASE" ||
    parsed.token !== token ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 2 * 60_000 ||
    JSON.stringify(suppliedTargets) !== JSON.stringify(expectedTargets)
  ) {
    throw new Error("Expired or invalid Hardware erase authorization.");
  }
  for (const target of [...new Set(expectedTargets)].sort(
    (left, right) => right.length - left.length,
  )) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(target, { recursive: true, force: true });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await delay(250);
      }
    }
    if (lastError) throw lastError;
  }
  await rm(marker, { force: true });
  return true;
}
