"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowRight,
  FolderKanban,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  createCollection,
  errorMessage,
  listCollections,
  listProjects,
} from "@/lib/client/api";
import type { UiCollection, UiProject } from "@/lib/client/contracts";

export function CollectionsClient() {
  const [collections, setCollections] = useState<UiCollection[]>([]);
  const [projects, setProjects] = useState<UiProject[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<UiCollection | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      limit: "100",
      sort: "recently_seen",
      view: "cards",
    });
    Promise.all([listCollections(), listProjects(query)])
      .then(([collectionRows, projectPage]) => {
        if (!active) return;
        setCollections(collectionRows);
        setProjects(projectPage.projects);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function submitCollection(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createCollection({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setCollections((items) => [created, ...items]);
      setName("");
      setDescription("");
      setCreateOpen(false);
      setNotice(`${created.name} was added to your library.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Card className="grid min-h-72 place-items-center shadow-none">
        <div className="text-center">
          <LoaderCircle className="mx-auto size-6 animate-spin text-[var(--accent)] motion-reduce:animate-none" />
          <p className="mt-3 text-xs text-[var(--muted)]">Loading collections</p>
        </div>
      </Card>
    );
  }

  return (
    <>
      {(error || notice) && (
        <div
          className={`mb-5 flex items-center gap-3 rounded-xl border px-4 py-3 text-xs ${
            error
              ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
              : "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"
          }`}
          role={error ? "alert" : "status"}
        >
          <span className="flex-1 font-medium">{error ?? notice}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
            aria-label="Dismiss message"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--muted)]">
          <span className="font-bold text-[var(--ink)]">{collections.length}</span> personal collections · one project can appear in several
        </p>
        <Button variant="accent" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" /> New collection
        </Button>
      </div>

      {collections.length === 0 ? (
        <Card className="grid min-h-64 place-items-center p-8 text-center shadow-none">
          <div>
            <FolderKanban className="mx-auto size-7 text-[var(--muted)]" />
            <h2 className="mt-3 text-sm font-bold">No collections yet</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Create a board for projects you want to compare, study, or revisit.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {collections.map((collection) => {
            const collectionProjects = collection.projectIds
              .map((id) =>
                projects.find((project) => project.id === id || project.slug === id),
              )
              .filter((project): project is UiProject => Boolean(project));
            return (
              <Card
                key={collection.id}
                className="group min-w-0 overflow-hidden flex min-h-64 flex-col p-5 shadow-none transition-[border-color,box-shadow] hover:border-[var(--line-strong)] hover:shadow-[0_8px_24px_var(--shadow-color)]"
              >
                <span
                  className="grid size-10 place-items-center rounded-xl text-white"
                  style={{ background: collection.accent }}
                >
                  <FolderKanban className="size-4.5" />
                </span>
                <h2 className="mt-4 break-words text-base font-bold tracking-[-0.025em] text-[var(--ink)] [overflow-wrap:anywhere]">
                  {collection.name}
                </h2>
                <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-[var(--muted-strong)]">
                  {collection.description || "No description yet."}
                </p>
                <div className="mt-5 flex min-h-9 items-center">
                  {collectionProjects.length > 0 ? (
                    <div className="flex -space-x-2">
                      {collectionProjects.slice(0, 5).map((project) => (
                        <span
                          key={project.id}
                          title={project.name}
                          className="grid size-8 place-items-center rounded-full border-2 border-[var(--surface)] text-[9px] font-black text-white"
                          style={{ background: project.accent }}
                        >
                          {project.initials}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[10px] text-[var(--muted)]">No projects yet</span>
                  )}
                </div>
                <div className="mt-auto flex items-center justify-between border-t border-[var(--line)] pt-4">
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-[var(--muted)]">
                    <FolderKanban className="size-3" />
                    {collection.projectCount} projects
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelected(collection)}
                    className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--accent-strong)] hover:underline"
                  >
                    Open <ArrowRight className="size-3" />
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-[var(--backdrop)] backdrop-blur-[2px]" />
          <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-8">
            <Dialog.Popup className="relative w-[540px] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-2xl outline-none">
              <div className="flex items-start justify-between">
                <div>
                  <span className="grid size-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
                    <FolderKanban className="size-5" />
                  </span>
                  <Dialog.Title className="mt-3 text-xl font-bold tracking-[-0.03em]">
                    Create a collection
                  </Dialog.Title>
                  <Dialog.Description className="mt-1.5 text-sm text-[var(--muted-strong)]">
                    Group projects around a question, build idea, or research theme.
                  </Dialog.Description>
                </div>
                <Dialog.Close
                  className={buttonVariants({ variant: "ghost", size: "icon" })}
                  aria-label="Close"
                >
                  <X className="size-4" />
                </Dialog.Close>
              </div>
              <form className="mt-6 space-y-4" onSubmit={submitCollection}>
                <label className="block text-xs font-semibold text-[var(--ink)]">
                  Name
                  <Input
                    className="mt-2"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Repository intelligence"
                    autoFocus
                    required
                    maxLength={160}
                  />
                </label>
                <label className="block text-xs font-semibold text-[var(--ink)]">
                  Description
                  <textarea
                    className="mt-2 min-h-24 w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="What belongs here?"
                    maxLength={1000}
                  />
                </label>
                <div className="flex justify-end gap-2 pt-2">
                  <Dialog.Close className={buttonVariants({ variant: "secondary" })}>
                    Cancel
                  </Dialog.Close>
                  <Button variant="accent" type="submit" disabled={busy}>
                    {busy ? "Creating…" : "Create collection"}
                  </Button>
                </div>
              </form>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(selected)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSelected(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-[var(--backdrop)] backdrop-blur-[2px]" />
          <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-8">
            {selected && (
              <Dialog.Popup className="relative w-[760px] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-2xl outline-none">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--accent-strong)]">
                      Personal collection
                    </p>
                    <Dialog.Title className="mt-1 break-words text-xl font-bold tracking-[-0.03em] [overflow-wrap:anywhere]">
                      {selected.name}
                    </Dialog.Title>
                    <Dialog.Description className="mt-2 text-sm text-[var(--muted-strong)]">
                      {selected.description || "No description yet."}
                    </Dialog.Description>
                  </div>
                  <Dialog.Close
                    className={buttonVariants({ variant: "ghost", size: "icon" })}
                    aria-label="Close"
                  >
                    <X className="size-4" />
                  </Dialog.Close>
                </div>
                <div className="mt-5 space-y-2">
                  {selected.projectIds.length ? (
                    selected.projectIds.map((id) => {
                      const project = projects.find(
                        (item) => item.id === id || item.slug === id,
                      );
                      if (!project) return null;
                      return (
                        <div
                          key={id}
                          className="flex items-center gap-3 rounded-xl border border-[var(--line)] p-3"
                        >
                          <span
                            className="grid size-9 place-items-center rounded-lg text-[9px] font-black text-white"
                            style={{ background: project.accent }}
                          >
                            {project.initials}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-bold">{project.name}</span>
                            <span className="block truncate text-[10px] text-[var(--muted)]">
                              {project.description}
                            </span>
                          </span>
                          <Link
                            href={`/projects/${project.slug || project.id}`}
                            className={buttonVariants({ variant: "ghost", size: "sm" })}
                          >
                            View
                          </Link>
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-xl border border-dashed border-[var(--line-strong)] p-8 text-center text-xs text-[var(--muted)]">
                      Add projects from Library or a project page.
                    </div>
                  )}
                </div>
                <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--line)] pt-5">
                  <div>
                    <p className="text-xs font-semibold">Stored in your personal library</p>
                    <p className="mt-0.5 text-[10px] text-[var(--muted)]">
                      Notes and Impressive flags remain attached to each project.
                    </p>
                  </div>
                  <Link
                    href={`/inventory?collection=${encodeURIComponent(selected.id)}`}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    View in Library <ArrowRight className="size-3.5" />
                  </Link>
                </div>
              </Dialog.Popup>
            )}
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
