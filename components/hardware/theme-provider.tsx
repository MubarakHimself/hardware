"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getHardwareDesktopBridge } from "@/lib/desktop/contracts";

export type ThemePreference = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

export const THEME_STORAGE_KEY = "hardware-theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

interface ThemeSnapshot {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
}

const serverSnapshot: ThemeSnapshot = {
  preference: "system",
  resolvedTheme: "light",
};
const listeners = new Set<() => void>();

function browserPreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(stored) ? stored : "system";
}

let browserSnapshot: ThemeSnapshot = serverSnapshot;
if (typeof window !== "undefined") {
  const preference = browserPreference();
  browserSnapshot = { preference, resolvedTheme: resolveTheme(preference) };
}

function getBrowserSnapshot(): ThemeSnapshot {
  return browserSnapshot;
}

function getServerSnapshot(): ThemeSnapshot {
  return serverSnapshot;
}

function publish(preference: ThemePreference): void {
  const next: ThemeSnapshot = {
    preference,
    resolvedTheme: resolveTheme(preference),
  };
  if (
    next.preference === browserSnapshot.preference &&
    next.resolvedTheme === browserSnapshot.resolvedTheme
  ) {
    return;
  }
  browserSnapshot = next;
  applyTheme(next.resolvedTheme);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handleSystemTheme = () => {
    if (browserSnapshot.preference === "system") publish("system");
  };
  media.addEventListener("change", handleSystemTheme);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", handleSystemTheme);
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribe,
    getBrowserSnapshot,
    getServerSnapshot,
  );

  useEffect(() => {
    const bridge = getHardwareDesktopBridge();
    if (!bridge) return;
    let active = true;
    void bridge
      .getDesktopPreferences()
      .then((preferences) => {
        if (!active) return;
        window.localStorage.setItem(THEME_STORAGE_KEY, preferences.theme);
        publish(preferences.theme);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback(
    (nextPreference: ThemePreference) => {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
      publish(nextPreference);
      void getHardwareDesktopBridge()
        ?.setDesktopPreferences({ theme: nextPreference })
        .catch(() => undefined);
    },
    [],
  );

  const value = useMemo(
    () => ({ ...snapshot, setPreference }),
    [snapshot, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is unavailable.");
  return value;
}

export const themeBootstrapScript = `(() => {
  try {
    const stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    const preference = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    const theme = preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : preference === 'system' ? 'light' : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch { document.documentElement.dataset.theme = 'light'; }
})();`;
