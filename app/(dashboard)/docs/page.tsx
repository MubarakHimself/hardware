import type { Metadata } from "next";
import { BotOff, Database, GitBranch, RadioTower, Search, ShieldCheck } from "lucide-react";
import { PageHeading } from "@/components/hardware/page-heading";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Product contract" };

const principles = [
  { icon: RadioTower, title: "Descriptions are source feeds", text: "Hardware reads public video descriptions through the official YouTube Data API and preserves exact timestamp provenance." },
  { icon: BotOff, title: "No AI in version one", text: "Parsing, matching, metadata, ranking, and review are deterministic. No transcript, embedding, summary, or agent call is made." },
  { icon: GitBranch, title: "Repository matches are conservative", text: "Direct repository identities may attach. Similar GitHub search results always wait for an administrator decision." },
  { icon: Search, title: "Search the evidence", text: "Names, metadata, topics, repositories, source titles, collection names, and your own notes are indexed with visibility boundaries." },
  { icon: ShieldCheck, title: "Private alpha", text: "Clerk gates production access. Server-side roles and ownership checks protect every mutation and private field." },
  { icon: Database, title: "PostgreSQL is authoritative", text: "Project identity, sightings, collections, jobs, and audits live in PostgreSQL on the existing Contabo deployment." },
];

export default function DocsPage() {
  return (
    <>
      <PageHeading eyebrow="Version 1 contract" title="How Hardware works" description="The operating principles behind the catalog. The complete engineering specification and BDD feature files live with the source." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {principles.map(({ icon: Icon, title, text }) => <Card key={title} className="p-5"><span className="grid size-9 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-strong)]"><Icon className="size-4" /></span><h2 className="mt-4 text-sm font-bold">{title}</h2><p className="mt-2 text-xs leading-5 text-[var(--muted-strong)]">{text}</p></Card>)}
      </div>
    </>
  );
}
