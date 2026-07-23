import type { Metadata } from "next";
import { ActivityClient } from "@/components/hardware/activity-client";
import { PageHeading } from "@/components/hardware/page-heading";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage() {
  return (
    <>
      <PageHeading
        eyebrow="Local operations"
        title="Activity"
        description="Follow background runs, retry isolated failures, resolve source evidence, and inspect local update or restore history."
      />
      <ActivityClient />
    </>
  );
}
