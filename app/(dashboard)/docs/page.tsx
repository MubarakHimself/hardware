import type { Metadata } from "next";
import {
  BotOff,
  CalendarClock,
  Database,
  GitBranch,
  HardDrive,
  RadioTower,
  Search,
  ShieldCheck,
  VideoOff,
} from "lucide-react";
import { PageHeading } from "@/components/hardware/page-heading";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "How Hardware works" };

const principles = [
  {
    icon: RadioTower,
    title: "Descriptions are source feeds",
    text: "Hardware reads video descriptions through the official YouTube Data API and keeps timestamped provenance for every detected project.",
  },
  {
    icon: VideoOff,
    title: "Metadata, never media",
    text: "No video, audio, frame, caption, transcript, or browser scrape is downloaded. Only provider metadata and linked project evidence are stored.",
  },
  {
    icon: CalendarClock,
    title: "One-off or monitored",
    text: "A video link is imported once. A channel can run manually, daily, or weekly and performs one catch-up run after this app has been offline.",
  },
  {
    icon: GitBranch,
    title: "Repository matches stay conservative",
    text: "Direct repository identities may attach automatically. Similar search results wait for your explicit decision.",
  },
  {
    icon: Search,
    title: "Search the evidence",
    text: "Names, topics, repositories, source titles, collection names, and your own notes become one searchable personal library.",
  },
  {
    icon: ShieldCheck,
    title: "Local by construction",
    text: "The app listens on this computer only. Do not expose its port to a network or tunnel.",
  },
  {
    icon: Database,
    title: "PostgreSQL is authoritative",
    text: "Project identity, sightings, collections, activity, and decisions live in a persistent local Docker volume.",
  },
  {
    icon: HardDrive,
    title: "Backups are encrypted",
    text: "Host backup files are encrypted before they leave the temporary backup container, with seven daily and four weekly restore points.",
  },
  {
    icon: BotOff,
    title: "AI and Instagram come later",
    text: "Version 1.1 uses deterministic parsing and matching. AI analysis, repository chat, Instagram, and other social video sources are intentionally out of scope.",
  },
];

export default function DocsPage() {
  return (
    <>
      <PageHeading
        eyebrow="Personal Local v1.1"
        title="How Hardware works"
        description="The product contract for source capture, deterministic indexing, local operation, and recoverable background work."
      />
      <div className="grid grid-cols-3 gap-4">
        {principles.map(({ icon: Icon, title, text }) => (
          <Card key={title} className="p-5 shadow-none">
            <span className="grid size-9 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-strong)]">
              <Icon className="size-4" />
            </span>
            <h2 className="mt-4 text-sm font-bold">{title}</h2>
            <p className="mt-2 text-xs leading-5 text-[var(--muted-strong)]">{text}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
