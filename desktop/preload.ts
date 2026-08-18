import { contextBridge, ipcRenderer } from "electron";
import type { HardwareDesktopBridge } from "../lib/desktop/contracts";
import { DESKTOP_CHANNELS } from "./channels";
import type {
  HardwareDesktopApi,
  NativeOperationProgress,
  RuntimeStatus,
} from "./types";

function subscription<T>(
  channel: string,
  listener: (value: T) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) =>
    listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge: HardwareDesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getAppInfo),
  getDesktopPreferences: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getDesktopPreferences),
  setDesktopPreferences: (input) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setDesktopPreferences, input),
  getRuntimeStatus: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getRuntimeStatus),
  getProviderStatus: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getProviderStatus),
  saveProviderCredential: (input) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.saveProviderCredential, input),
  clearProviderCredential: (provider) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.clearProviderCredential, provider),
  chooseBackupDirectory: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.chooseBackupDirectory),
  createBackup: () => ipcRenderer.invoke(DESKTOP_CHANNELS.createBackup),
  restoreBackup: () => ipcRenderer.invoke(DESKTOP_CHANNELS.restoreBackup),
  exportRecoveryKey: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.exportRecoveryKey),
  openLogsFolder: () => ipcRenderer.invoke(DESKTOP_CHANNELS.openLogsFolder),
  openReleasesPage: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openReleasesPage),
  retryStartup: () => ipcRenderer.invoke(DESKTOP_CHANNELS.retryStartup),
  quit: () => ipcRenderer.invoke(DESKTOP_CHANNELS.quit),
  unlockCredentialVault: (passphrase) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.unlockCredentialVault, passphrase),
  eraseAllLocalData: (confirmation) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.eraseAllLocalData, confirmation),
  onRuntimeStatus: (listener) =>
    subscription<RuntimeStatus>(DESKTOP_CHANNELS.runtimeStatus, listener),
  onNativeOperationProgress: (listener) =>
    subscription<NativeOperationProgress>(
      DESKTOP_CHANNELS.nativeOperationProgress,
      listener,
    ),
};

// This assignment forces the exposed surface to retain the shared renderer
// contract even though the native recovery page has three additional methods.
const rendererContract: HardwareDesktopBridge = bridge;
contextBridge.exposeInMainWorld("hardwareDesktop", rendererContract);
