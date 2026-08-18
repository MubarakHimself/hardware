"use client";

import {
  Activity,
  Check,
  Database,
  ExternalLink,
  FolderOpen,
  Github,
  HardDrive,
  KeyRound,
  Laptop,
  LoaderCircle,
  Moon,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sun,
  TerminalSquare,
  Trash2,
  Youtube,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  openDesktopOnboarding,
} from "@/components/hardware/desktop-onboarding";
import { PageHeading } from "@/components/hardware/page-heading";
import {
  useTheme,
  type ThemePreference,
} from "@/components/hardware/theme-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { errorMessage, getProviderStatuses } from "@/lib/client/api";
import {
  getHardwareDesktopBridge,
  type DesktopAppInfo,
  type DesktopProvider,
  type ProviderStatus,
  type RuntimeStatus,
  type NativeOperationProgress,
} from "@/lib/desktop/contracts";
import { cn } from "@/lib/utils";

const themes: Array<{
  value: ThemePreference;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    value: "system",
    label: "System",
    description: "Follow this computer",
    icon: Laptop,
  },
  {
    value: "light",
    label: "Light",
    description: "Bright research desk",
    icon: Sun,
  },
  {
    value: "dark",
    label: "Dark",
    description: "Low-light desk",
    icon: Moon,
  },
];

const browserOperations = [
  ["Start Hardware", ".\\hardware.ps1 start"],
  ["Create backup", ".\\hardware.ps1 backup"],
  ["Check services", ".\\hardware.ps1 status"],
  ["Install daily backup", ".\\hardware.ps1 install-backup-task"],
] as const;

export function SettingsClient() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
  const [editing, setEditing] = useState<DesktopProvider | null>(null);
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [nativeOperation, setNativeOperation] =
    useState<NativeOperationProgress | null>(null);
  const [eraseConfirmation, setEraseConfirmation] = useState("");

  const refreshProviders = useCallback(async () => {
    const bridge = getHardwareDesktopBridge();
    const value = bridge
      ? await bridge.getProviderStatus()
      : await getProviderStatuses();
    setProviders(value);
  }, []);

  useEffect(() => {
    const bridge = getHardwareDesktopBridge();
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeOperation: (() => void) | undefined;
    const desktopTimer = window.setTimeout(() => {
      if (active) setDesktop(Boolean(bridge));
    }, 0);

    void (async () => {
      try {
        const providerValue = bridge
          ? await bridge.getProviderStatus()
          : await getProviderStatuses();
        if (!active) return;
        setProviders(providerValue);
        if (bridge) {
          const [runtimeValue, infoValue] = await Promise.all([
            bridge.getRuntimeStatus(),
            bridge.getAppInfo(),
          ]);
          if (!active) return;
          setRuntime(runtimeValue);
          setAppInfo(infoValue);
          unsubscribe = bridge.onRuntimeStatus((status) => {
            if (active) setRuntime(status);
          });
          unsubscribeOperation = bridge.onNativeOperationProgress((progress) => {
            if (!active) return;
            setNativeOperation(
              progress.total > 0 && progress.completed >= progress.total
                ? null
                : progress,
            );
          });
        }
      } catch (error) {
        if (active) setLoadError(errorMessage(error));
      }
    })();

    return () => {
      active = false;
      window.clearTimeout(desktopTimer);
      unsubscribe?.();
      unsubscribeOperation?.();
    };
  }, []);

  async function saveCredential(provider: DesktopProvider) {
    const bridge = getHardwareDesktopBridge();
    if (!bridge || !credential.trim()) return;
    setBusy(`save:${provider}`);
    setNotice(null);
    try {
      const result = await bridge.saveProviderCredential({
        provider,
        credential: credential.trim(),
      });
      setCredential("");
      setEditing(null);
      await refreshProviders();
      setNotice(result.detail);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function clearCredential(provider: DesktopProvider) {
    const bridge = getHardwareDesktopBridge();
    if (!bridge) return;
    setBusy(`clear:${provider}`);
    setNotice(null);
    try {
      await bridge.clearProviderCredential(provider);
      await refreshProviders();
      setNotice(
        `${provider === "youtube" ? "YouTube" : "GitHub"} credential removed.`,
      );
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function runNative(
    action: "backup" | "restore" | "directory" | "recovery-key",
  ) {
    const bridge = getHardwareDesktopBridge();
    if (!bridge) return;
    setBusy(action);
    setNotice(null);
    try {
      if (action === "backup") {
        const result = await bridge.createBackup();
        setNotice(`Encrypted backup created: ${result.displayName}.`);
      } else if (action === "restore") {
        const result = await bridge.restoreBackup();
        setNotice(result.detail);
      } else if (action === "directory") {
        const selected = await bridge.chooseBackupDirectory();
        setNotice(
          selected
            ? "Backup destination updated."
            : "Backup destination was not changed.",
        );
      } else {
        await bridge.exportRecoveryKey();
        setNotice("Recovery key exported.");
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function eraseAllLocalData() {
    const bridge = getHardwareDesktopBridge();
    if (!bridge || eraseConfirmation !== "ERASE" || nativeOperation || busy) {
      return;
    }
    setBusy("erase");
    setNotice(null);
    try {
      await bridge.eraseAllLocalData(eraseConfirmation);
      setEraseConfirmation("");
      setNotice("Local Hardware data was erased.");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1180px]">
      <PageHeading
        eyebrow={desktop ? "Hardware desktop" : "Personal local"}
        title="Settings"
        description="Integrations, appearance, backups, runtime health, and recovery controls for this computer."
      />

      {(notice || loadError) && (
        <p
          className={cn(
            "mt-5 rounded-xl border px-4 py-3 text-xs",
            loadError
              ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
              : "border-[var(--line)] bg-[var(--surface)] text-[var(--muted-strong)]",
          )}
          role="status"
        >
          {loadError ?? notice}
        </p>
      )}

      <div className="mt-7 grid grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)] gap-5">
        <div className="space-y-5">
          <SettingsSection
            icon={KeyRound}
            title="Integrations"
            description="Credentials stay in the native vault. Provider secrets never enter renderer storage or logs."
            action={
              desktop ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={openDesktopOnboarding}
                >
                  <RotateCcw className="size-3.5" />
                  Guided setup
                </Button>
              ) : undefined
            }
          >
            <div className="space-y-3">
              {providers.length === 0 && !loadError && (
                <p className="flex items-center gap-2 text-xs text-[var(--muted)]">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Checking provider readiness…
                </p>
              )}
              {providers.map((provider) => (
                <ProviderRow
                  key={provider.provider}
                  status={provider}
                  desktop={desktop}
                  editing={editing === provider.provider}
                  credential={editing === provider.provider ? credential : ""}
                  busy={busy}
                  onEdit={() => {
                    setEditing(provider.provider);
                    setCredential("");
                    setNotice(null);
                  }}
                  onCancel={() => {
                    setEditing(null);
                    setCredential("");
                  }}
                  onCredential={setCredential}
                  onSave={() => void saveCredential(provider.provider)}
                  onClear={() => void clearCredential(provider.provider)}
                />
              ))}
            </div>
            {!desktop && (
              <p className="mt-4 rounded-lg border border-[var(--warning-line)] bg-[var(--warning-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--warning)]">
                Browser mode reads credentials from the host environment. Use
                the desktop application to manage them from Settings.
              </p>
            )}
          </SettingsSection>

          <SettingsSection
            icon={Sun}
            title="Appearance"
            description="System is the default. Your choice stays on this device."
            action={
              <Badge variant="neutral" className="capitalize">
                {resolvedTheme} active
              </Badge>
            }
          >
            <div
              className="grid grid-cols-3 gap-3"
              role="radiogroup"
              aria-label="Color theme"
            >
              {themes.map(({ value, label, description, icon: Icon }) => {
                const selected = preference === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setPreference(value)}
                    className={cn(
                      "relative rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                      selected
                        ? "border-[var(--accent-line)] bg-[var(--accent-soft)]"
                        : "border-[var(--line)] bg-[var(--surface-subtle)] hover:border-[var(--line-strong)]",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-5",
                        selected
                          ? "text-[var(--accent-strong)]"
                          : "text-[var(--muted)]",
                      )}
                    />
                    <span className="mt-4 block text-xs font-bold">{label}</span>
                    <span className="mt-1 block text-[10px] text-[var(--muted)]">
                      {description}
                    </span>
                    {selected && (
                      <Check className="absolute right-3 top-3 size-3.5 text-[var(--accent-strong)]" />
                    )}
                  </button>
                );
              })}
            </div>
          </SettingsSection>

          <SettingsSection
            icon={HardDrive}
            title="Backups"
            description="Encrypted automatic backups remain separate from the installed application."
          >
            <ul className="space-y-2 text-[10px] leading-4 text-[var(--muted-strong)]">
              <li className="flex gap-2">
                <Check className="mt-0.5 size-3 shrink-0 text-[var(--success)]" />
                Created when the newest backup is over 24 hours old and before migrations.
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 size-3 shrink-0 text-[var(--success)]" />
                Seven daily restore points plus the newest backup from four ISO weeks.
              </li>
              <li className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-3 shrink-0 text-[var(--accent-strong)]" />
                The recovery key must be exported for off-machine restoration.
              </li>
            </ul>
            {desktop ? (
              <div className="mt-5 grid grid-cols-2 gap-2">
                <NativeAction
                  icon={HardDrive}
                  label="Create backup"
                  busy={busy === "backup"}
                  onClick={() => void runNative("backup")}
                />
                <NativeAction
                  icon={RefreshCw}
                  label="Restore backup"
                  busy={busy === "restore"}
                  onClick={() => void runNative("restore")}
                />
                <NativeAction
                  icon={FolderOpen}
                  label="Choose folder"
                  busy={busy === "directory"}
                  onClick={() => void runNative("directory")}
                />
                <NativeAction
                  icon={KeyRound}
                  label="Export recovery key"
                  busy={busy === "recovery-key"}
                  onClick={() => void runNative("recovery-key")}
                />
              </div>
            ) : (
              <BrowserOperations />
            )}
          </SettingsSection>
        </div>

        <div className="space-y-5">
          <SettingsSection
            icon={Activity}
            title="Desktop runtime"
            description={
              desktop
                ? "Every service belongs to this window and stops when Hardware exits."
                : "Docker-backed local runtime status."
            }
          >
            <div className="space-y-2">
              <RuntimeRow
                icon={Database}
                label="PostgreSQL"
                value={desktop ? runtime?.database ?? "starting" : "host volume"}
              />
              <RuntimeRow
                icon={Activity}
                label="Background worker"
                value={desktop ? runtime?.worker ?? "starting" : "local service"}
              />
              <RuntimeRow
                icon={Laptop}
                label="Web interface"
                value={desktop ? runtime?.web ?? "ready" : "loopback only"}
              />
            </div>
            {runtime?.detail && (
              <p className="mt-3 text-[10px] leading-4 text-[var(--muted)]">
                {runtime.detail}
              </p>
            )}
          </SettingsSection>

          <SettingsSection
            icon={TerminalSquare}
            title="Diagnostics"
            description="Logs and runtime details remain on this computer."
          >
            {desktop ? (
              <Button
                variant="secondary"
                className="w-full justify-start"
                onClick={() =>
                  void getHardwareDesktopBridge()
                    ?.openLogsFolder()
                    .catch((error) => setNotice(errorMessage(error)))
                }
              >
                <FolderOpen className="size-4" />
                Open logs folder
              </Button>
            ) : (
              <p className="rounded-lg border border-[var(--warning-line)] bg-[var(--warning-soft)] px-3 py-2.5 text-[10px] leading-4 text-[var(--warning)]">
                Do not expose the local port to another device or a tunnel.
              </p>
            )}
          </SettingsSection>

          <SettingsSection
            icon={ShieldCheck}
            title="Local boundary"
            description="Hardware is a single-user application on this computer."
          >
            <div className="space-y-2 text-[10px] text-[var(--muted-strong)]">
              <p className="flex items-center gap-2">
                <Check className="size-3 text-[var(--success)]" />
                No account or login
              </p>
              <p className="flex items-center gap-2">
                <Check className="size-3 text-[var(--success)]" />
                Loopback network listeners only
              </p>
              <p className="flex items-center gap-2">
                <Check className="size-3 text-[var(--success)]" />
                No telemetry or remote crash upload
              </p>
            </div>
          </SettingsSection>

          <SettingsSection
            icon={Laptop}
            title="About"
            description="Unsigned personal alpha with manual updates."
          >
            <dl className="space-y-2 text-[10px]">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--muted)]">Version</dt>
                <dd className="font-mono font-semibold">
                  {appInfo?.version ?? "browser development"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--muted)]">Platform</dt>
                <dd className="font-mono font-semibold">
                  {appInfo
                    ? `${appInfo.platform} ${appInfo.architecture}`
                    : "local web"}
                </dd>
              </div>
            </dl>
            {desktop && (
              <Button
                variant="secondary"
                className="mt-4 w-full"
                onClick={() =>
                  void getHardwareDesktopBridge()
                    ?.openReleasesPage()
                    .catch((error) => setNotice(errorMessage(error)))
                }
              >
                <ExternalLink className="size-4" />
                Open GitHub Releases
              </Button>
            )}
          </SettingsSection>

          {desktop && (
            <Card className="border-[var(--danger-line)] p-5 shadow-none">
              <div className="flex items-center gap-3 text-[var(--danger)]">
                <Trash2 className="size-4" />
                <h2 className="text-sm font-bold">Local data</h2>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-[var(--muted)]">
                Permanently erase the library, provider configuration, runtime
                state, and local logs from this computer. External encrypted
                backup files are not deleted.
              </p>
              <label className="mt-4 block text-[10px] font-bold text-[var(--danger)]">
                Type ERASE to confirm
                <Input
                  className="mt-2"
                  value={eraseConfirmation}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setEraseConfirmation(event.target.value)}
                  placeholder="ERASE"
                  aria-label="Type ERASE to confirm permanent local data deletion"
                  disabled={Boolean(nativeOperation) || busy === "erase"}
                />
              </label>
              <Button
                variant="danger"
                className="mt-3 w-full"
                disabled={
                  eraseConfirmation !== "ERASE" ||
                  Boolean(nativeOperation) ||
                  Boolean(busy)
                }
                onClick={() => void eraseAllLocalData()}
              >
                {busy === "erase" ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                Erase all local data
              </Button>
              {nativeOperation && (
                <p className="mt-2 text-[10px] text-[var(--warning)]">
                  Finish the active {nativeOperation.operation} operation before erasing data.
                </p>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsSection({
  icon: Icon,
  title,
  description,
  action,
  children,
}: {
  icon: typeof Laptop;
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5 shadow-none">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-strong)]">
            <Icon className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-bold">{title}</h2>
            <p className="mt-0.5 text-[10px] leading-4 text-[var(--muted)]">
              {description}
            </p>
          </div>
        </div>
        {action}
      </div>
      <div className="mt-5">{children}</div>
    </Card>
  );
}

function ProviderRow({
  status,
  desktop,
  editing,
  credential,
  busy,
  onEdit,
  onCancel,
  onCredential,
  onSave,
  onClear,
}: {
  status: ProviderStatus;
  desktop: boolean;
  editing: boolean;
  credential: string;
  busy: string | null;
  onEdit: () => void;
  onCancel: () => void;
  onCredential: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const Icon = status.provider === "youtube" ? Youtube : Github;
  const saving = busy === `save:${status.provider}`;
  const clearing = busy === `clear:${status.provider}`;

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-subtle)] p-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-4 text-[var(--muted)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs font-bold">{status.label}</p>
            <Badge variant={status.configured ? "success" : "neutral"}>
              {status.configured
                ? status.verification === "verified"
                  ? "verified"
                  : "configured"
                : "not configured"}
            </Badge>
          </div>
          <p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">
            {status.detail}
          </p>
          {editing ? (
            <div className="mt-3">
              <Input
                type="password"
                value={credential}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => onCredential(event.target.value)}
                placeholder={
                  status.configured
                    ? "Paste replacement credential"
                    : `Paste ${status.label} credential`
                }
                aria-label={`${status.label} credential`}
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onCancel}>
                  Cancel
                </Button>
                <Button
                  variant="accent"
                  size="sm"
                  disabled={saving || !credential.trim()}
                  onClick={onSave}
                >
                  {saving ? "Validating…" : "Validate and save"}
                </Button>
              </div>
            </div>
          ) : (
            desktop && (
              <div className="mt-3 flex gap-2">
                <Button variant="secondary" size="sm" onClick={onEdit}>
                  {status.configured ? "Replace" : "Configure"}
                </Button>
                {status.configured && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={clearing}
                    onClick={onClear}
                  >
                    {clearing ? "Removing…" : "Remove"}
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function NativeAction({
  icon: Icon,
  label,
  busy,
  onClick,
}: {
  icon: typeof Laptop;
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className="justify-start"
      disabled={busy}
      onClick={onClick}
    >
      {busy ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <Icon className="size-3.5" />
      )}
      {label}
    </Button>
  );
}

function RuntimeRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Laptop;
  label: string;
  value: string;
}) {
  const healthy = value === "ready";
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--surface-subtle)] px-3 py-2.5">
      <span className="flex items-center gap-2 text-[10px] font-semibold">
        <Icon className="size-3.5 text-[var(--muted)]" />
        {label}
      </span>
      <span
        className={cn(
          "text-[10px] font-bold capitalize",
          healthy ? "text-[var(--success)]" : "text-[var(--muted-strong)]",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function BrowserOperations() {
  return (
    <div className="mt-5 divide-y divide-[var(--line)] rounded-xl border border-[var(--line)]">
      {browserOperations.map(([label, command]) => (
        <div
          key={label}
          className="flex items-center justify-between gap-4 px-3 py-3"
        >
          <span className="text-[10px] font-semibold text-[var(--muted-strong)]">
            {label}
          </span>
          <code className="select-all rounded-md bg-[var(--surface-sunken)] px-2 py-1 font-mono text-[9px] text-[var(--ink-soft)]">
            {command}
          </code>
        </div>
      ))}
    </div>
  );
}
