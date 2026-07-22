import type { Metadata } from "next";
import { ProjectDetailClient } from "@/components/hardware/project-detail-client";

export const metadata: Metadata = { title: "Project" };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectDetailClient id={id} />;
}
