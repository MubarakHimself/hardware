/*
 * Renderer-visible contracts live in lib/desktop/contracts.ts. This module only
 * re-exports those contracts and adds main-process-only types so the preload,
 * renderer, and main process cannot drift independently.
 */
export type {
  BackupManifest,
  BackupResult,
  DesktopAppInfo,
  DesktopPreferences,
  DesktopProvider,
  DesktopThemePreference,
  HardwareDesktopBridge,
  NativeOperationProgress,
  ProviderCredentialInput,
  ProviderStatus,
  ProviderValidationResult,
  ProviderVerification,
  RestoreResult,
  RuntimePhase,
  RuntimeStatus,
} from "../lib/desktop/contracts";

import type {
  HardwareDesktopBridge,
  RuntimePhase,
} from "../lib/desktop/contracts";

export type RuntimeStage =
  | "unlocking_vault"
  | "preparing"
  | "starting_database"
  | "backing_up"
  | "migrating"
  | "starting_worker"
  | "starting_web"
  | "checking_readiness"
  | "ready"
  | "draining"
  | "stopping"
  | "recovery";

export function publicRuntimePhase(stage: RuntimeStage): RuntimePhase {
  switch (stage) {
    case "unlocking_vault":
    case "preparing":
      return "starting";
    case "starting_database":
    case "backing_up":
      return "database";
    case "migrating":
      return "migrating";
    case "starting_worker":
      return "worker";
    case "starting_web":
    case "checking_readiness":
      return "web";
    default:
      return stage;
  }
}

export interface ActiveWork {
  queued: number;
  running: number;
  total: number;
  byType: Array<{
    type: string;
    queued: number;
    running: number;
  }>;
}

export interface NativeRecoveryBridge {
  retryStartup(): Promise<void>;
  quit(): Promise<void>;
  unlockCredentialVault(passphrase: string): Promise<void>;
  eraseAllLocalData(confirmation: "ERASE"): Promise<void>;
}

export type HardwareDesktopApi = HardwareDesktopBridge &
  NativeRecoveryBridge;
