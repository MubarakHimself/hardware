import { HardwareShell } from "@/components/hardware/hardware-shell";
import { requireRequestCapability } from "@/lib/server/auth";
import { getServerConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requireRequestCapability("catalog:read");
  return (
    <HardwareShell mode={getServerConfig().mode}>
      {children}
    </HardwareShell>
  );
}
