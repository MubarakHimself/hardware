import type {
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainInvokeEvent,
  Shell,
} from "electron";
import path from "node:path";
import { BackupAuthenticationError, type BackupService } from "./backup";
import { DESKTOP_CHANNELS } from "./channels";
import type { NativeOperationCoordinator } from "./operation-coordinator";
import type { RuntimePaths } from "./paths";
import { isPathInside } from "./paths";
import type { ProviderCredentialService } from "./providers";
import {
  desktopPreferencesUpdateSchema,
  eraseConfirmationSchema,
  providerCredentialInputSchema,
  providerNameSchema,
  vaultPassphraseSchema,
} from "./schemas";
import { verifyIpcSender } from "./security";
import type { DesktopSettingsStore } from "./settings";
import type {
  DesktopAppInfo,
  DesktopPreferences,
  NativeOperationProgress,
} from "./types";
import type { DesktopRuntime } from "./runtime";
import type { CredentialVault } from "./vault";

export interface DesktopIpcOptions {
  ipcMain: IpcMain;
  dialog: Dialog;
  shell: Shell;
  getWindow: () => BrowserWindow | undefined;
  getApplicationOrigin: () => string | undefined;
  appInfo: DesktopAppInfo;
  releasesUrl: string;
  paths: RuntimePaths;
  settings: DesktopSettingsStore;
  vault: CredentialVault;
  providers: ProviderCredentialService;
  backup: BackupService;
  runtime: DesktopRuntime;
  requestQuit: () => Promise<void>;
  eraseAllLocalData: (confirmation: "ERASE") => Promise<void>;
  operations: NativeOperationCoordinator;
}

export function registerDesktopIpc(
  options: DesktopIpcOptions,
): () => void {
  const registered: string[] = [];
  const handle = <TArguments extends unknown[], TResult>(
    channel: string,
    callback: (
      event: IpcMainInvokeEvent,
      ...arguments_: TArguments
    ) => TResult | Promise<TResult>,
  ) => {
    options.ipcMain.removeHandler(channel);
    options.ipcMain.handle(
      channel,
      async (event, ...arguments_: unknown[]) => {
        const window = options.getWindow();
        if (!window) throw new Error("The Hardware window is unavailable.");
        verifyIpcSender(event, window, options.getApplicationOrigin());
        return callback(event, ...(arguments_ as TArguments));
      },
    );
    registered.push(channel);
  };

  handle(DESKTOP_CHANNELS.getAppInfo, () => options.appInfo);
  handle(DESKTOP_CHANNELS.getDesktopPreferences, () => {
    const settings = options.settings.snapshot();
    return {
      onboardingCompleted: settings.onboardingCompleted,
      theme: settings.theme,
    } satisfies DesktopPreferences;
  });
  handle(
    DESKTOP_CHANNELS.setDesktopPreferences,
    async (_event, input: unknown) => {
      const update = desktopPreferencesUpdateSchema.parse(input);
      await options.settings.update(update);
    },
  );
  handle(DESKTOP_CHANNELS.getRuntimeStatus, () => options.runtime.status);
  handle(DESKTOP_CHANNELS.getProviderStatus, () =>
    options.providers.statuses(),
  );
  handle(
    DESKTOP_CHANNELS.saveProviderCredential,
    async (_event, input: unknown) =>
      options.operations.run("provider", () =>
        options.providers.save(providerCredentialInputSchema.parse(input)),
      ),
  );
  handle(
    DESKTOP_CHANNELS.clearProviderCredential,
    async (_event, provider: unknown) =>
      options.operations.run("provider", () =>
        options.providers.clear(providerNameSchema.parse(provider)),
      ),
  );
  handle(DESKTOP_CHANNELS.chooseBackupDirectory, async () => {
    const window = options.getWindow();
    if (!window) return null;
    const selected = await options.dialog.showOpenDialog(window, {
      title: "Choose Hardware backup folder",
      defaultPath: options.backup.directory,
      properties: ["openDirectory", "createDirectory"],
    });
    const directory = selected.filePaths[0];
    if (selected.canceled || !directory) return null;
    const resolved = path.resolve(directory);
    if (
      options.paths.profileRoots.some((root) =>
        isPathInside(root, resolved),
      )
    ) {
      await options.dialog.showMessageBox(window, {
        type: "warning",
        title: "Choose a separate backup folder",
        message:
          "Backups must stay outside Hardware's application-data folders.",
      });
      return null;
    }
    await options.settings.update({ backupDirectory: resolved });
    return resolved;
  });
  handle(DESKTOP_CHANNELS.createBackup, () =>
    options.operations.run("backup", () => options.runtime.createBackup()),
  );
  handle(DESKTOP_CHANNELS.restoreBackup, async () =>
    options.operations.run("restore", async () => {
    const window = options.getWindow();
    if (!window) {
      return { restored: false, detail: "The Hardware window is unavailable." };
    }
    const selected = await options.dialog.showOpenDialog(window, {
      title: "Restore Hardware backup",
      defaultPath: options.backup.directory,
      filters: [
        { name: "Hardware backup", extensions: ["hardware-backup"] },
      ],
      properties: ["openFile"],
    });
    const archive = selected.filePaths[0];
    if (selected.canceled || !archive) {
      return { restored: false, detail: "Restore canceled." };
    }
    const confirmation = await options.dialog.showMessageBox(window, {
      type: "warning",
      title: "Replace the current Hardware library?",
      message:
        "Hardware will create a fresh safety backup, then replace the current local library with the selected backup.",
      detail:
        "The current database remains available until the restored catalog passes migration and readiness checks.",
      buttons: ["Cancel", "Create safety backup and restore"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) {
      return { restored: false, detail: "Restore canceled." };
    }
    await options.runtime.createBackup();
    try {
      return await options.runtime.restoreBackup(archive);
    } catch (error) {
      if (!(error instanceof BackupAuthenticationError)) throw error;
      const response = await options.dialog.showMessageBox(window, {
        type: "warning",
        title: "Recovery key required",
        message:
          "This backup needs a different recovery key. Select its exported recovery-key file to continue.",
        buttons: ["Select recovery key", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response.response !== 0) {
        return { restored: false, detail: "Restore canceled." };
      }
      const keySelection = await options.dialog.showOpenDialog(window, {
        title: "Select Hardware recovery key",
        filters: [{ name: "JSON recovery key", extensions: ["json"] }],
        properties: ["openFile"],
      });
      const recoveryKey = keySelection.filePaths[0];
      if (keySelection.canceled || !recoveryKey) {
        return { restored: false, detail: "Restore canceled." };
      }
      return options.runtime.restoreBackup(archive, recoveryKey);
    }
    }),
  );
  handle(DESKTOP_CHANNELS.exportRecoveryKey, async () => {
    const window = options.getWindow();
    if (!window) return;
    const result = await options.dialog.showSaveDialog(window, {
      title: "Export Hardware recovery key",
      defaultPath: path.join(
        path.dirname(options.paths.defaultBackupDirectory),
        "Hardware-Recovery-Key.json",
      ),
      filters: [{ name: "JSON recovery key", extensions: ["json"] }],
    });
    if (!result.canceled && result.filePath) {
      if (
        path.dirname(path.resolve(result.filePath)) ===
        path.resolve(options.backup.directory)
      ) {
        await options.dialog.showMessageBox(window, {
          type: "warning",
          title: "Keep the recovery key separate",
          message:
            "Choose a folder outside the Hardware backup directory so one storage failure cannot lose both archives and their recovery key.",
        });
        return;
      }
      await options.backup.exportRecoveryKey(result.filePath);
    }
  });
  handle(
    DESKTOP_CHANNELS.unlockCredentialVault,
    async (_event, passphrase: unknown) => {
      await options.vault.unlock(vaultPassphraseSchema.parse(passphrase));
    },
  );
  handle(
    DESKTOP_CHANNELS.eraseAllLocalData,
    async (_event, confirmation: unknown) =>
      options.operations.run("erase", () =>
        options.eraseAllLocalData(
          eraseConfirmationSchema.parse(confirmation),
        ),
      ),
  );
  handle(DESKTOP_CHANNELS.openLogsFolder, async () => {
    const failure = await options.shell.openPath(options.paths.logs);
    if (failure) throw new Error("The logs folder could not be opened.");
  });
  handle(DESKTOP_CHANNELS.openReleasesPage, async () => {
    await options.shell.openExternal(options.releasesUrl);
  });
  handle(DESKTOP_CHANNELS.retryStartup, () =>
    options.operations.run("lifecycle", () => options.runtime.retry()),
  );
  handle(DESKTOP_CHANNELS.quit, () => options.requestQuit());

  return () => {
    for (const channel of registered) options.ipcMain.removeHandler(channel);
  };
}

export function sendRuntimeStatus(
  window: BrowserWindow | undefined,
  status: unknown,
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(DESKTOP_CHANNELS.runtimeStatus, status);
}

export function sendNativeOperationProgress(
  window: BrowserWindow | undefined,
  progress: NativeOperationProgress,
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(
    DESKTOP_CHANNELS.nativeOperationProgress,
    progress,
  );
}
