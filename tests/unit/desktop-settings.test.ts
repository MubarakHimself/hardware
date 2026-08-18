import { describe, expect, it } from "vitest";
import {
  DesktopSettingsStore,
  type SettingsFileAdapter,
} from "../../desktop/settings";

describe("desktop settings", () => {
  it("serializes updates through atomic temporary-file renames", async () => {
    const files = new Map<string, string>();
    const renames: Array<[string, string]> = [];
    const adapter: SettingsFileAdapter = {
      read: async (file) => {
        const value = files.get(file);
        if (value === undefined) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return value;
      },
      write: async (file, contents) => {
        files.set(file, contents);
      },
      rename: async (from, to) => {
        renames.push([from, to]);
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      },
      remove: async (file) => {
        files.delete(file);
      },
      makeDirectory: async () => undefined,
    };
    const store = new DesktopSettingsStore(
      "C:\\Hardware\\config\\settings.json",
      adapter,
    );
    await store.load();
    await Promise.all([
      store.update({ theme: "dark" }),
      store.update({ onboardingCompleted: true }),
    ]);

    expect(store.snapshot()).toMatchObject({
      theme: "dark",
      onboardingCompleted: true,
    });
    expect(renames).toHaveLength(2);
    expect(renames.every(([, to]) => to.endsWith("settings.json"))).toBe(true);
  });
});

