import type { Metadata } from "next";
import { ChannelsClient } from "@/components/hardware/channels-client";
import { PageHeading } from "@/components/hardware/page-heading";
import { requireRequestCapability } from "@/lib/server/auth";

export const metadata: Metadata = { title: "Sources" };

export default async function ChannelsPage() {
  await requireRequestCapability("channels:manage");
  return (
    <>
      <PageHeading
        eyebrow="Source operations"
        title="Sources"
        description="Monitor YouTube channels, choose manual or scheduled syncs, inspect history progress, and retry only failed work."
      />
      <ChannelsClient />
    </>
  );
}
