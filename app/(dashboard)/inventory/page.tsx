import type { Metadata } from "next";
import { Suspense } from "react";
import { InventoryClient } from "@/components/hardware/inventory-client";
import { PageHeading } from "@/components/hardware/page-heading";

export const metadata: Metadata = { title: "Inventory" };

export default function InventoryPage() {
  return (
    <>
      <PageHeading
        eyebrow="Shared catalog"
        title="Inventory"
        description="Search the deduplicated project catalog by product, repository, topic, source video, or the note only you can see."
      />
      <Suspense fallback={<div className="h-64 animate-pulse rounded-xl border border-[var(--line)] bg-[var(--surface)] motion-reduce:animate-none" />}>
        <InventoryClient />
      </Suspense>
    </>
  );
}
