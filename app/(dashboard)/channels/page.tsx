import type { Metadata } from "next";
import { ChannelsClient } from "@/components/hardware/channels-client";
import { PageHeading } from "@/components/hardware/page-heading";
import { requireRequestCapability } from "@/lib/server/auth";

export const metadata: Metadata = { title: "Channels" };

export default async function ChannelsPage() {
  await requireRequestCapability("channels:manage");
  return (
    <>
      <PageHeading
        eyebrow="Source operations"
        title="Channels"
        description="Monitor official YouTube source feeds, inspect backfill progress, and recover individual videos without replaying successful work."
      />
      <ChannelsClient />
    </>
  );
}
