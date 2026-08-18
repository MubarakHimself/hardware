"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Github,
  KeyRound,
  Laptop,
  ShieldCheck,
  Youtube,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getHardwareDesktopBridge,
  type DesktopProvider,
  type ProviderStatus,
} from "@/lib/desktop/contracts";

const OPEN_EVENT = "hardware:open-desktop-onboarding";

type Step = "welcome" | "youtube" | "github" | "backups" | "finish";

const steps: Step[] = [
  "welcome",
  "youtube",
  "github",
  "backups",
  "finish",
];

export function openDesktopOnboarding(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(OPEN_EVENT));
  }
}

export function DesktopOnboarding() {
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [credential, setCredential] = useState("");
  const [backupDirectory, setBackupDirectory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const bridge = getHardwareDesktopBridge();
  const step = steps[stepIndex] ?? "welcome";

  useEffect(() => {
    const desktop = getHardwareDesktopBridge();
    if (!desktop) return;

    let active = true;
    void Promise.all([
      desktop.getProviderStatus(),
      desktop.getDesktopPreferences(),
    ])
      .then(([providerStatuses, preferences]) => {
        if (!active) return;
        setStatuses(providerStatuses);
        if (!preferences.onboardingCompleted) setOpen(true);
      })
      .catch(() => undefined);

    const reopen = () => {
      setStepIndex(0);
      setMessage(null);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, reopen);
    return () => {
      active = false;
      window.removeEventListener(OPEN_EVENT, reopen);
    };
  }, []);

  function goToStep(index: number) {
    setCredential("");
    setMessage(null);
    setStepIndex(Math.max(0, Math.min(steps.length - 1, index)));
  }

  async function saveProvider(provider: DesktopProvider) {
    if (!bridge || !credential.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await bridge.saveProviderCredential({
        provider,
        credential: credential.trim(),
      });
      setStatuses(await bridge.getProviderStatus());
      setCredential("");
      setMessage(result.detail);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The credential could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function chooseBackupDirectory() {
    if (!bridge) return;
    setBusy(true);
    try {
      setBackupDirectory(await bridge.chooseBackupDirectory());
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The backup folder could not be selected.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function exportRecoveryKey() {
    if (!bridge) return;
    setBusy(true);
    setMessage(null);
    try {
      await bridge.exportRecoveryKey();
      setMessage("Recovery key exported. Keep that file separate from this computer.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The recovery key could not be exported.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!bridge) return;
    setBusy(true);
    setMessage(null);
    try {
      await bridge.setDesktopPreferences({ onboardingCompleted: true });
      setOpen(false);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "First-run setup could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!bridge) return null;

  const youtube = statuses.find((item) => item.provider === "youtube");
  const github = statuses.find((item) => item.provider === "github");

  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-[var(--backdrop)] backdrop-blur-[3px]" />
        <Dialog.Viewport className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto p-8">
          <Dialog.Popup className="w-[650px] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-2xl outline-none">
            <div className="border-b border-[var(--line)] px-7 py-6">
              <div className="flex items-center justify-between gap-6">
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--accent-strong)]">
                  First-run setup
                </span>
                <span className="text-[10px] font-semibold text-[var(--muted)]">
                  {stepIndex + 1} of {steps.length}
                </span>
              </div>
              <div className="mt-3 flex gap-1.5" aria-hidden="true">
                {steps.map((item, index) => (
                  <span
                    key={item}
                    className={`h-1 flex-1 rounded-full ${
                      index <= stepIndex
                        ? "bg-[var(--accent)]"
                        : "bg-[var(--surface-sunken)]"
                    }`}
                  />
                ))}
              </div>
            </div>

            <div className="min-h-[320px] px-7 py-7">
              {step === "welcome" && (
                <SetupStep
                  icon={Laptop}
                  title="Welcome to Hardware"
                  description="This is your private desktop library. There is no account, login, cloud workspace, or background service."
                >
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      ["Local library", "Stored on this computer"],
                      ["Full exit", "Stops when the window closes"],
                      ["Setup later", "Every credential is optional"],
                    ].map(([title, detail]) => (
                      <div
                        key={title}
                        className="rounded-xl border border-[var(--line)] bg-[var(--surface-subtle)] p-4"
                      >
                        <p className="text-xs font-bold">{title}</p>
                        <p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">
                          {detail}
                        </p>
                      </div>
                    ))}
                  </div>
                </SetupStep>
              )}

              {step === "youtube" && (
                <SetupStep
                  icon={Youtube}
                  title="Connect YouTube"
                  description="A YouTube Data API key enables one-off video imports and monitored channel synchronization. Skip this and the rest of Hardware remains available."
                >
                  <CredentialSetup
                    configured={Boolean(youtube?.configured)}
                    value={credential}
                    onChange={setCredential}
                    placeholder="Paste YouTube API key"
                    busy={busy}
                    onSave={() => void saveProvider("youtube")}
                  />
                </SetupStep>
              )}

              {step === "github" && (
                <SetupStep
                  icon={Github}
                  title="Optional GitHub token"
                  description="Public repository metadata works without a token. Adding one raises API limits for larger libraries and frequent refreshes."
                >
                  <CredentialSetup
                    configured={Boolean(github?.configured)}
                    value={credential}
                    onChange={setCredential}
                    placeholder="Paste GitHub token"
                    busy={busy}
                    onSave={() => void saveProvider("github")}
                  />
                </SetupStep>
              )}

              {step === "backups" && (
                <SetupStep
                  icon={ShieldCheck}
                  title="Protect the library"
                  description="Hardware creates encrypted backups automatically. Export the recovery key and store it somewhere separate; a backup cannot be restored without it."
                >
                  <div className="space-y-3">
                    <Button
                      variant="secondary"
                      className="w-full justify-start"
                      disabled={busy}
                      onClick={() => void chooseBackupDirectory()}
                    >
                      <FolderOpen className="size-4" />
                      {backupDirectory
                        ? "Backup folder selected"
                        : "Choose backup folder"}
                    </Button>
                    <Button
                      variant="secondary"
                      className="w-full justify-start"
                      disabled={busy}
                      onClick={() => void exportRecoveryKey()}
                    >
                      <KeyRound className="size-4" />
                      Export recovery key
                    </Button>
                  </div>
                </SetupStep>
              )}

              {step === "finish" && (
                <SetupStep
                  icon={Check}
                  title="Your library is ready"
                  description="Start with an empty library, then import a YouTube link, website, GitHub repository, or monitored channel whenever you are ready."
                >
                  <div className="rounded-xl border border-[var(--success-line)] bg-[var(--success-soft)] p-4 text-xs leading-5 text-[var(--success)]">
                    You can repeat this setup or replace credentials from Settings at any time.
                  </div>
                </SetupStep>
              )}

              {message && (
                <p
                  className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--surface-subtle)] px-3 py-2 text-xs text-[var(--muted-strong)]"
                  role="status"
                >
                  {message}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-[var(--line)] px-7 py-5">
              <Button
                variant="ghost"
                disabled={stepIndex === 0 || busy}
                onClick={() => goToStep(stepIndex - 1)}
              >
                <ChevronLeft className="size-4" />
                Back
              </Button>
              {step === "finish" ? (
                <Button
                  variant="accent"
                  disabled={busy}
                  onClick={() => void finish()}
                >
                  Open Hardware
                  <Check className="size-4" />
                </Button>
              ) : (
                <Button
                  variant="accent"
                  disabled={busy}
                  onClick={() => goToStep(stepIndex + 1)}
                >
                  {step === "youtube" || step === "github"
                    ? "Continue or skip"
                    : "Continue"}
                  <ChevronRight className="size-4" />
                </Button>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SetupStep({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Laptop;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <span className="grid size-11 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
        <Icon className="size-5" />
      </span>
      <Dialog.Title className="mt-4 text-xl font-bold tracking-[-0.025em]">
        {title}
      </Dialog.Title>
      <Dialog.Description className="mt-2 max-w-xl text-sm leading-6 text-[var(--muted-strong)]">
        {description}
      </Dialog.Description>
      <div className="mt-6">{children}</div>
    </>
  );
}

function CredentialSetup({
  configured,
  value,
  onChange,
  placeholder,
  busy,
  onSave,
}: {
  configured: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  busy: boolean;
  onSave: () => void;
}) {
  return (
    <div className="space-y-3">
      {configured && (
        <p className="flex items-center gap-2 rounded-lg border border-[var(--success-line)] bg-[var(--success-soft)] px-3 py-2 text-xs font-semibold text-[var(--success)]">
          <Check className="size-3.5" />
          A credential is already configured.
        </p>
      )}
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={configured ? "Paste replacement credential" : placeholder}
          aria-label={placeholder}
        />
        <Button
          variant="secondary"
          disabled={busy || !value.trim()}
          onClick={onSave}
        >
          {busy ? "Checking…" : configured ? "Replace" : "Save"}
        </Button>
      </div>
      <p className="text-[10px] leading-4 text-[var(--muted)]">
        The value is sent only to Hardware&apos;s native credential vault and is never stored in this page.
      </p>
    </div>
  );
}
