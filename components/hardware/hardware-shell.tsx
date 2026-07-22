"use client";

import { UserButton } from "@clerk/nextjs";
import { Dialog } from "@base-ui/react/dialog";
import {
  Activity,
  Archive,
  BellDot,
  BookOpen,
  Command,
  FolderKanban,
  Import,
  Menu,
  Plus,
  RadioTower,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  HardwareRuntimeProvider,
  type HardwareRuntime,
} from "@/components/hardware/runtime-context";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { errorMessage, queueImport } from "@/lib/client/api";
import type { UiJob } from "@/lib/client/contracts";
import { cn } from "@/lib/utils";

const navigation = [
  { href: "/radar", label: "Radar", icon: RadioTower },
  { href: "/inventory", label: "Inventory", icon: Archive },
  { href: "/collections", label: "Collections", icon: FolderKanban },
  { href: "/channels", label: "Channels", icon: Activity, adminOnly: true },
];

function NavLinks({
  onNavigate,
  role,
}: {
  onNavigate?: () => void;
  role: HardwareRuntime["role"];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {navigation
        .filter((item) => !item.adminOnly || role === "admin")
        .map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                active
                  ? "bg-white/11 text-white"
                  : "text-white/60 hover:bg-white/7 hover:text-white",
              )}
            >
              <Icon className={cn("size-4", active ? "text-[var(--sidebar-accent)]" : "text-white/45")} />
              <span>{label}</span>
            </Link>
          );
        })}
    </nav>
  );
}

function SidebarContent({
  onNavigate,
  mode,
  role,
}: {
  onNavigate?: () => void;
  mode: HardwareRuntime["mode"];
  role: HardwareRuntime["role"];
}) {
  return (
    <>
      <div className="flex h-18 items-center gap-3 border-b border-white/8 px-5">
        <div className="grid size-8 place-items-center rounded-lg bg-[var(--sidebar-accent)] text-sm font-black tracking-[-0.04em] text-[#16231d]">
          HW
        </div>
        <div>
          <p className="text-sm font-bold tracking-[-0.01em] text-white">Hardware</p>
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-white/35">Project index</p>
        </div>
      </div>

      <div className="flex-1 px-3 py-5">
        <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">
          Workspace
        </p>
        <NavLinks onNavigate={onNavigate} role={role} />

        <div className="mt-8 rounded-xl border border-white/8 bg-white/[0.035] p-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-white/72">
            <BellDot className="size-3.5 text-[var(--sidebar-accent)]" />
            Ingestion enabled
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/8">
            <div className="h-full w-[86%] rounded-full bg-[var(--sidebar-accent)]" />
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-white/34">
            <span>6 hour polling</span>
            <span>durable jobs</span>
          </div>
        </div>
      </div>

      <div className="border-t border-white/8 p-3">
        {mode === "production" ? (
          <div className="rounded-lg px-2 py-2 text-white [&_.cl-userButtonOuterIdentifier]:text-white">
            <UserButton showName />
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg px-2 py-2" aria-label={`Demo ${role} account`}>
            <span className="grid size-8 place-items-center rounded-full bg-white/10 text-xs font-bold text-white">DM</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-white">Demo account</span>
              <span className="block truncate text-[10px] text-white/38">Workspace {role}</span>
            </span>
          </div>
        )}
      </div>
    </>
  );
}

function importKind(value: string): "youtube_video" | "website" | "github_repository" {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("Unsupported URL");
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube_video";
  if (host === "github.com" && parsed.pathname.split("/").filter(Boolean).length >= 2) return "github_repository";
  return "website";
}

function ImportDialog({
  open,
  onOpenChange,
  onViewRadar,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewRadar: () => void;
}) {
  const [value, setValue] = useState("");
  const [submittedJob, setSubmittedJob] = useState<UiJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen) {
      setValue("");
      setSubmittedJob(null);
      setBusy(false);
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = new URL(value.trim());
      const job = await queueImport(
        parsed.toString(),
        importKind(parsed.toString()),
      );
      setSubmittedJob(job);
    } catch (cause) {
      setError(cause instanceof TypeError ? "Enter a complete public HTTP(S) URL." : errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-[#111914]/55 backdrop-blur-[2px]" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
          <Dialog.Popup className="relative w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-2xl outline-none">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="mb-3 grid size-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
                  <Import className="size-5" />
                </div>
                <Dialog.Title className="text-xl font-bold tracking-[-0.025em] text-[var(--ink)]">
                  Import a source
                </Dialog.Title>
                <Dialog.Description className="mt-1.5 text-sm leading-6 text-[var(--muted-strong)]">
                  Add one YouTube video, project website, or public GitHub repository. Hardware will use the deterministic ingestion pipeline.
                </Dialog.Description>
              </div>
              <Dialog.Close className={buttonVariants({ variant: "ghost", size: "icon" })} aria-label="Close">
                <X className="size-4" />
              </Dialog.Close>
            </div>

            {submittedJob ? (
              <div className="mt-6 rounded-xl border border-[var(--success-line)] bg-[var(--success-soft)] p-4" role="status">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-[var(--success)]">Import queued</p>
                  <Badge variant="success">{submittedJob.state}</Badge>
                </div>
                <p className="mt-1 break-all text-xs leading-5 text-[var(--muted-strong)]">{value}</p>
                <div className="mt-3 rounded-lg border border-[var(--success-line)] bg-white/45 p-3">
                  <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">Job ID</p>
                  <p className="mt-1 break-all font-mono text-[10px] text-[var(--muted-strong)]">{submittedJob.id}</p>
                </div>
                <Button className="mt-4" size="sm" onClick={onViewRadar}>Back to Radar</Button>
              </div>
            ) : (
              <form onSubmit={submit} className="mt-6">
                <label htmlFor="import-url" className="text-xs font-semibold text-[var(--ink)]">Source URL</label>
                <Input
                  id="import-url"
                  className="mt-2"
                  placeholder="https://youtube.com/watch?v=…"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  autoFocus
                  inputMode="url"
                  required
                />
                <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">
                  Supported: public YouTube videos, HTTP(S) project pages, and public github.com repositories.
                </p>
                {error && <p className="mt-3 text-xs font-medium text-[var(--danger)]" role="alert">{error}</p>}
                <div className="mt-6 flex justify-end gap-2">
                  <Dialog.Close className={buttonVariants({ variant: "secondary" })}>Cancel</Dialog.Close>
                  <Button variant="accent" type="submit" disabled={busy}>
                    <Plus className="size-4" /> {busy ? "Queuing…" : "Queue import"}
                  </Button>
                </div>
              </form>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function HardwareShell({
  children,
  mode,
  role,
}: {
  children: ReactNode;
  mode: HardwareRuntime["mode"];
  role: HardwareRuntime["role"];
}) {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useState("");

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = quickSearch.trim();
    router.push(query ? `/inventory?q=${encodeURIComponent(query)}` : "/inventory");
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("global-search")?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <HardwareRuntimeProvider value={{ mode, role }}>
      <div className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
        <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col bg-[var(--sidebar)] lg:flex">
          <SidebarContent mode={mode} role={role} />
        </aside>

        <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/45 lg:hidden" />
            <Dialog.Viewport className="fixed inset-0 z-50 lg:hidden">
              <Dialog.Popup className="flex h-full w-[min(82vw,18rem)] flex-col bg-[var(--sidebar)] shadow-2xl outline-none">
                <Dialog.Title className="sr-only">Primary navigation</Dialog.Title>
                <SidebarContent mode={mode} role={role} onNavigate={() => setMobileOpen(false)} />
              </Dialog.Popup>
            </Dialog.Viewport>
          </Dialog.Portal>
        </Dialog.Root>

        <div className="lg:pl-60">
          <header className="sticky top-0 z-30 flex h-18 items-center gap-3 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--canvas)_88%,transparent)] px-4 backdrop-blur-xl sm:px-6 xl:px-8">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
              <Menu className="size-5" />
            </Button>

            <form onSubmit={search} className="relative max-w-xl flex-1" role="search">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" />
              <Input
                id="global-search"
                value={quickSearch}
                onChange={(event) => setQuickSearch(event.target.value)}
                placeholder="Search projects, repos, topics, videos…"
                aria-label="Search Hardware"
                className="h-9 bg-[var(--surface)] pl-9 pr-14"
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-[var(--line)] bg-[var(--surface-raised)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--muted)] sm:flex">
                <Command className="size-2.5" /> K
              </span>
            </form>

            <Link href="/docs" className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "hidden sm:inline-flex")} aria-label="Documentation">
              <BookOpen className="size-4" />
            </Link>
            <Button variant="accent" size="sm" onClick={() => setImportOpen(true)}>
              <Plus className="size-3.5" />
              <span className="hidden sm:inline">Import</span>
            </Button>
            {mode === "production" ? (
              <div className="sm:hidden"><UserButton /></div>
            ) : (
              <span className="grid size-8 place-items-center rounded-full bg-[var(--ink)] text-[10px] font-bold text-white sm:hidden" aria-label={`Demo ${role} account`}>DM</span>
            )}
          </header>

          <main id="main-content" className="mx-auto w-full max-w-[1560px] px-4 py-6 sm:px-6 sm:py-8 xl:px-8">
            {children}
          </main>
        </div>

        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          onViewRadar={() => {
            setImportOpen(false);
            router.push("/radar");
          }}
        />
      </div>
    </HardwareRuntimeProvider>
  );
}
