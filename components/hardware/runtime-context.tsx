"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface HardwareRuntime {
  mode: "demo" | "production";
  role: "member" | "admin";
}

const RuntimeContext = createContext<HardwareRuntime | null>(null);

export function HardwareRuntimeProvider({
  value,
  children,
}: {
  value: HardwareRuntime;
  children: ReactNode;
}) {
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useHardwareRuntime(): HardwareRuntime {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("Hardware runtime context is unavailable.");
  return value;
}
