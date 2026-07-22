import type { Metadata } from "next";
import { CollectionsClient } from "@/components/hardware/collections-client";
import { PageHeading } from "@/components/hardware/page-heading";

export const metadata: Metadata = { title: "Collections" };

export default function CollectionsPage() {
  return (
    <>
      <PageHeading
        eyebrow="Your workspace"
        title="Collections"
        description="Keep projects in several purpose-built boards. Collections begin private and can be shared read-only when you choose."
      />
      <CollectionsClient />
    </>
  );
}
