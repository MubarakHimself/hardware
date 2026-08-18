import type { Metadata } from "next";
import { PageHeading } from "@/components/hardware/page-heading";
import { RadarClient } from "@/components/hardware/radar-client";

export const metadata: Metadata = { title: "Radar" };

export default function RadarPage() {
  const dateLabel = new Intl.DateTimeFormat("en", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date());
  return (
    <>
      <PageHeading
        eyebrow={dateLabel}
        title="Radar"
        description="Fresh project sightings, source health, and the small set of personal library decisions that need your attention."
      />
      <RadarClient />
    </>
  );
}
