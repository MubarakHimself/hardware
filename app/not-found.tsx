import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--canvas)] p-6 text-center">
      <div>
        <span className="mx-auto grid size-12 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)]"><SearchX className="size-5" /></span>
        <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--accent-strong)]">404 · Not found</p>
        <h1 className="mt-2 text-2xl font-bold tracking-[-0.04em]">That project is not in the catalog</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--muted-strong)]">It may have been merged into another canonical project, or the link may be incomplete.</p>
        <Link href="/inventory" className={cn(buttonVariants({ variant: "secondary" }), "mt-5")}><ArrowLeft className="size-4" /> Back to Inventory</Link>
      </div>
    </main>
  );
}
