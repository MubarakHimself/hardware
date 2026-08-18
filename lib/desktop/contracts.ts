export type DesktopProvider = "youtube" | "github";

export type ProviderVerification =
  | "verified"
  | "unverified"
  | "not_configured";

export interface ProviderStatus {
  provider: DesktopProvider;
  label: string;
  configured: boolean;
  required: boolean;
  verification: ProviderVerification;
  detail: string;
  lastValidatedAt?: string | null;
}

export interface ProviderCredentialInput {
  provider: DesktopProvider;
  credential: string;
}

export interface ProviderValidationResult {
  provider: DesktopProvider;
  configured: boolean;
  verification: Exclude<ProviderVerification, "not_configured">;
  detail: string;
}

export type RuntimePhase =
  | "idle"
  | "starting"
  | "database"
  | "migrating"
  | "worker"
  | "web"
  | "ready"
  | "draining"
  | "stopping"
  | "recovery"
  | "failed";

export interface RuntimeStatus {
  phase: RuntimePhase;
  ready: boolean;
  detail: string;
  database: "stopped" | "starting" | "ready" | "failed";
  worker: "stopped" | "starting" | "ready" | "failed";
  web: "stopped" | "starting" | "ready" | "failed";
  activeJobs?: {
    queued: number;
    running: number;
    total: number;
  };
}

export interface NativeOperationProgress {
  operation: "backup" | "restore" | "migration" | "startup";
  phase: string;
  completed: number;
  total: number;
  detail: string;
}

export interface BackupManifest {
  formatVersion: number;
  appVersion: string;
  schemaVersion: string;
  postgresMajor: number;
  createdAt: string;
  archiveId: string;
}

export interface BackupResult {
  archiveId: string;
  createdAt: string;
  displayName: string;
}

export interface RestoreResult {
  restored: boolean;
  archiveId?: string;
  detail: string;
}

export interface DesktopAppInfo {
  name: "Hardware";
  version: string;
  platform: "win32" | "linux";
  architecture: string;
  packaged: boolean;
  releasesUrl: string;
}

export type DesktopThemePreference = "light" | "dark" | "system";

export interface DesktopPreferences {
  onboardingCompleted: boolean;
  theme: DesktopThemePreference;
}

export interface HardwareDesktopBridge {
  getAppInfo(): Promise<DesktopAppInfo>;
  getDesktopPreferences(): Promise<DesktopPreferences>;
  setDesktopPreferences(input: Partial<DesktopPreferences>): Promise<void>;
  getRuntimeStatus(): Promise<RuntimeStatus>;
  getProviderStatus(): Promise<ProviderStatus[]>;
  saveProviderCredential(
    input: ProviderCredentialInput,
  ): Promise<ProviderValidationResult>;
  clearProviderCredential(provider: DesktopProvider): Promise<void>;
  chooseBackupDirectory(): Promise<string | null>;
  createBackup(): Promise<BackupResult>;
  restoreBackup(): Promise<RestoreResult>;
  exportRecoveryKey(): Promise<void>;
  eraseAllLocalData(confirmation: "ERASE"): Promise<void>;
  openLogsFolder(): Promise<void>;
  openReleasesPage(): Promise<void>;
  onRuntimeStatus(listener: (status: RuntimeStatus) => void): () => void;
  onNativeOperationProgress(
    listener: (progress: NativeOperationProgress) => void,
  ): () => void;
}

export function getHardwareDesktopBridge(): HardwareDesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.hardwareDesktop ?? null;
}

declare global {
  interface Window {
    hardwareDesktop?: HardwareDesktopBridge;
  }
}
