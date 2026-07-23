"use client";

import { CircleAlert, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card className="grid min-h-[28rem] place-items-center p-8 text-center">
      <div>
        <span className="mx-auto grid size-12 place-items-center rounded-xl bg-[var(--danger-soft)] text-[var(--danger)]"><CircleAlert className="size-5" /></span>
        <h1 className="mt-4 text-xl font-bold tracking-[-0.03em]">This view could not be loaded</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--muted-strong)]">Your library is unchanged. Retry the request; if the source is still unavailable, the job will remain visible in Activity.</p>
        <Button className="mt-5" variant="secondary" onClick={reset}><RotateCcw className="size-4" /> Try again</Button>
      </div>
    </Card>
  );
}
