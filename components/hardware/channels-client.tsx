"use client";

import { Dialog } from "@base-ui/react/dialog";
import { AlertTriangle, Check, Clock3, LoaderCircle, Plus, RefreshCw, RadioTower, RotateCcw, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { addChannel, errorMessage, listChannels, retryJob, syncChannel } from "@/lib/client/api";
import type { UiChannel } from "@/lib/client/contracts";

export function ChannelsClient() {
  const [channels, setChannels] = useState<UiChannel[]>([]);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listChannels()
      .then((rows) => { if (active) setChannels(rows); })
      .catch((cause) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function submitChannel(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const channel = await addChannel(url.trim());
      setChannels((items) => [channel, ...items.filter((item) => item.id !== channel.id)]);
      setUrl("");
      setOpen(false);
      setNotice("Channel resolution and historical backfill were queued.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function runChannel(channel: UiChannel) {
    setBusyId(channel.id);
    setError(null);
    try {
      if (channel.retryableJobId) await retryJob(channel.retryableJobId);
      else await syncChannel(channel.id);
      setChannels((items) => items.map((item) => item.id === channel.id ? { ...item, status: "syncing", progressLabel: channel.retryableJobId ? "Retry queued" : "Sync queued", lastSync: "just now" } : item));
      setNotice(channel.retryableJobId ? `Retry queued for ${channel.name}.` : `Synchronization queued for ${channel.name}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {(error || notice) && (
        <div className={`mb-5 flex items-center gap-3 rounded-xl border px-4 py-3 text-xs ${error ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]" : "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"}`} role={error ? "alert" : "status"}>
          <span className="flex-1 font-medium">{error ?? notice}</span><button onClick={() => { setError(null); setNotice(null); }} aria-label="Dismiss message"><X className="size-3.5" /></button>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]"><Badge variant="accent">Admin</Badge><span>Channel changes affect the shared catalog and are audited.</span></div>
        <Button variant="accent" size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> Add channel</Button>
      </div>

      <Card className="overflow-hidden">
        <div className="hidden grid-cols-[minmax(12rem,1.4fr)_7rem_7rem_minmax(13rem,1fr)_8rem_auto] gap-4 border-b border-[var(--line)] bg-[var(--surface-subtle)] px-5 py-3 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)] md:grid"><span>Source</span><span>Videos</span><span>Projects</span><span>Sync status</span><span>Next run</span><span className="text-right">Action</span></div>
        {loading ? (
          <div className="grid min-h-56 place-items-center"><div className="text-center"><LoaderCircle className="mx-auto size-6 animate-spin text-[var(--accent)] motion-reduce:animate-none" /><p className="mt-3 text-xs text-[var(--muted)]">Reading source operations</p></div></div>
        ) : channels.length === 0 ? (
          <div className="grid min-h-56 place-items-center p-8 text-center"><div><RadioTower className="mx-auto size-7 text-[var(--muted)]" /><h2 className="mt-3 text-sm font-bold">No monitored channels</h2><p className="mt-1 text-xs text-[var(--muted)]">Add an official YouTube channel to begin a checkpointed backfill.</p></div></div>
        ) : (
          <div className="divide-y divide-[var(--line)]">
            {channels.map((channel) => (
              <div key={channel.id} className="grid gap-4 px-4 py-4 md:grid-cols-[minmax(12rem,1.4fr)_7rem_7rem_minmax(13rem,1fr)_8rem_auto] md:items-center md:px-5">
                <div className="flex items-center gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--ink)] text-[10px] font-black text-white">{channel.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span><span className="min-w-0"><span className="block truncate text-sm font-bold text-[var(--ink)]">{channel.name}</span><span className="mt-0.5 block truncate text-[10px] text-[var(--muted)]">{channel.handle || channel.youtubeChannelId}</span></span></div>
                <div><p className="text-sm font-bold">{channel.videos.toLocaleString()}</p><p className="text-[9px] text-[var(--muted)] md:hidden">Videos</p></div>
                <div><p className="text-sm font-bold">{channel.projects.toLocaleString()}</p><p className="text-[9px] text-[var(--muted)] md:hidden">Projects</p></div>
                <div>
                  <div className="flex items-center justify-between gap-2"><span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-[var(--muted-strong)]">{channel.status === "healthy" && <Check className="size-3 text-[var(--success)]" />}{channel.status === "syncing" && <RefreshCw className="size-3 animate-spin text-[var(--accent)] motion-reduce:animate-none" />}{channel.status === "attention" && <AlertTriangle className="size-3 text-[var(--warning)]" />}{channel.progressLabel ?? "All accessible videos current"}</span>{channel.progress !== undefined && <span className="text-[9px] font-bold text-[var(--muted)]">{channel.progress}%</span>}</div>
                  {channel.progress !== undefined && <Progress className="mt-2" value={channel.progress} label={`${channel.name} synchronization`} />}
                  <p className="mt-1.5 text-[9px] text-[var(--muted)]">{channel.lastSync}{channel.failures > 0 ? ` · ${channel.failures} failed` : ""}{channel.warnings > 0 ? ` · ${channel.warnings} warnings` : ""}</p>
                </div>
                <div className="inline-flex items-center gap-1 text-[10px] text-[var(--muted)]"><Clock3 className="size-3" />{channel.nextSync}</div>
                <div className="flex justify-end"><Button variant={channel.status === "attention" ? "secondary" : "ghost"} size="sm" onClick={() => runChannel(channel)} disabled={busyId === channel.id}>{channel.status === "attention" ? <RotateCcw className="size-3" /> : <RefreshCw className="size-3" />}{busyId === channel.id ? "Queuing…" : channel.status === "attention" ? "Retry" : "Sync"}</Button></div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <Card className="p-4"><p className="text-[10px] font-semibold text-[var(--muted)]">Polling schedule</p><p className="mt-2 text-sm font-bold">Every 6 hours</p><p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">Channels use their official uploads playlist and independent video jobs.</p></Card>
        <Card className="p-4"><p className="text-[10px] font-semibold text-[var(--muted)]">Policy revalidation</p><p className="mt-2 text-sm font-bold">Within 30 days</p><p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">Unavailable YouTube metadata is purged while non-YouTube catalog identity remains.</p></Card>
        <Card className="p-4"><p className="text-[10px] font-semibold text-[var(--muted)]">Parser version</p><p className="mt-2 font-mono text-sm font-bold">youtube-description/v1</p><p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">Deterministic, source-preserving, and covered by the 20-project golden fixture.</p></Card>
      </div>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-[#111914]/55 backdrop-blur-[2px]" />
          <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
            <Dialog.Popup className="relative w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-2xl outline-none">
              <div className="flex items-start justify-between"><div><span className="grid size-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-strong)]"><RadioTower className="size-5" /></span><Dialog.Title className="mt-3 text-xl font-bold tracking-[-0.03em]">Monitor a channel</Dialog.Title><Dialog.Description className="mt-1.5 text-sm leading-6 text-[var(--muted-strong)]">Hardware will resolve the canonical YouTube channel, enumerate its official uploads playlist, and backfill each accessible video independently.</Dialog.Description></div><Dialog.Close className={buttonVariants({ variant: "ghost", size: "icon" })} aria-label="Close"><X className="size-4" /></Dialog.Close></div>
              <form onSubmit={submitChannel} className="mt-6"><label htmlFor="channel-url" className="text-xs font-semibold">YouTube channel URL or handle</label><Input id="channel-url" className="mt-2" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://youtube.com/@channel" autoFocus required /><p className="mt-2 text-[10px] leading-4 text-[var(--muted)]">Official YouTube Data API only. Hardware never scrapes the channel UI or requests captions.</p><div className="mt-6 flex justify-end gap-2"><Dialog.Close className={buttonVariants({ variant: "secondary" })}>Cancel</Dialog.Close><Button variant="accent" type="submit" disabled={submitting}>{submitting ? "Queuing…" : "Resolve and backfill"}</Button></div></form>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
