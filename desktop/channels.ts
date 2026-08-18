export const DESKTOP_CHANNELS = {
  getAppInfo: "hardware:desktop:get-app-info",
  getDesktopPreferences: "hardware:desktop:get-preferences",
  setDesktopPreferences: "hardware:desktop:set-preferences",
  getRuntimeStatus: "hardware:desktop:get-runtime-status",
  getProviderStatus: "hardware:desktop:get-provider-status",
  saveProviderCredential: "hardware:desktop:save-provider-credential",
  clearProviderCredential: "hardware:desktop:clear-provider-credential",
  chooseBackupDirectory: "hardware:desktop:choose-backup-directory",
  createBackup: "hardware:desktop:create-backup",
  restoreBackup: "hardware:desktop:restore-backup",
  exportRecoveryKey: "hardware:desktop:export-recovery-key",
  openLogsFolder: "hardware:desktop:open-logs-folder",
  openReleasesPage: "hardware:desktop:open-releases-page",
  retryStartup: "hardware:desktop:retry-startup",
  quit: "hardware:desktop:quit",
  unlockCredentialVault: "hardware:desktop:unlock-vault",
  eraseAllLocalData: "hardware:desktop:erase-all-local-data",
  runtimeStatus: "hardware:desktop:runtime-status",
  nativeOperationProgress: "hardware:desktop:native-operation-progress",
} as const;

export const TRUSTED_BOOTSTRAP_ORIGIN = "hardware://bootstrap";
export const BOOTSTRAP_URL = `${TRUSTED_BOOTSTRAP_ORIGIN}/`;
