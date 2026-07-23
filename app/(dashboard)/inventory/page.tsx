import type { Metadata } from "next";
import { Suspense } from "react";
import { InventoryClient } from "@/components/hardware/inventory-client";
import { PageHeading } from "@/components/hardware/page-heading";

export const metadata: Metadata = { title: "Library" };

export default function InventoryPage() {
  return (
    <>
      <PageHeading
        eyebrow="Personal library"
        title="Library"
        description="Search your deduplicated project index by product, repository, topic, source video, collection, or personal note."
      />
      <Suspense fallback={<div className="h-64 animate-pulse rounded-xl border border-[var(--line)] bg-[var(--surface)] motion-reduce:animate-none" />}>
        <InventoryClient />
      </Suspense>
    </>
  );
}
