import type { Metadata } from "next";
import { CollectionsClient } from "@/components/hardware/collections-client";
import { PageHeading } from "@/components/hardware/page-heading";

export const metadata: Metadata = { title: "Collections" };

export default function CollectionsPage() {
  return (
    <>
      <PageHeading
        eyebrow="Personal library"
        title="Collections"
        description="Keep projects in several purpose-built boards for comparisons, build ideas, and research threads you want to revisit."
      />
      <CollectionsClient />
    </>
  );
}
