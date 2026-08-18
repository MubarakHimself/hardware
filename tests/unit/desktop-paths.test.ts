import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPathInside,
  resolveRuntimePaths,
  validateEraseTarget,
} from "../../desktop/paths";
import { clampWindowBounds } from "../../desktop/window-state";

describe("desktop runtime paths", () => {
  it("keeps Windows state in the per-user local application directory", () => {
    const paths = resolveRuntimePaths({
      platform: "win32",
      environment: { LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local" },
      homeDirectory: "C:\\Users\\Owner",
      documentsDirectory: "C:\\Users\\Owner\\Documents",
    });

    expect(paths.root).toBe(
      path.resolve("C:\\Users\\Owner\\AppData\\Local", "Hardware"),
    );
    expect(paths.postgresData).toBe(path.join(paths.root, "data", "postgres"));
    expect(paths.defaultBackupDirectory).toBe(
      path.resolve("C:\\Users\\Owner\\Documents", "Hardware Backups"),
    );
    expect(paths.profileRoots).toEqual([paths.root]);
  });

  it("honors XDG roots without putting AppImage data beside the executable", () => {
    const paths = resolveRuntimePaths({
      platform: "linux",
      environment: {
        XDG_DATA_HOME: "/home/owner/.data",
        XDG_CONFIG_HOME: "/home/owner/.config",
        XDG_STATE_HOME: "/home/owner/.state",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      homeDirectory: "/home/owner",
      documentsDirectory: "/home/owner/Documents",
    });

    expect(paths.postgresData).toBe(
      path.resolve("/home/owner/.data/hardware/postgres"),
    );
    expect(paths.vaultFile).toBe(
      path.resolve("/home/owner/.config/hardware/credentials.vault"),
    );
    expect(paths.runtime).toBe(path.resolve("/run/user/1000/hardware"));
  });

  it("refuses broad erase targets", () => {
    expect(() => validateEraseTarget(path.parse(process.cwd()).root)).toThrow(
      /unsafe profile path/i,
    );
    expect(() => validateEraseTarget(path.dirname(process.cwd()))).toThrow(
      /unsafe profile path/i,
    );
    expect(validateEraseTarget(path.join(process.cwd(), "Hardware"))).toBe(
      path.resolve(process.cwd(), "Hardware"),
    );
  });

  it("uses boundary-aware path confinement", () => {
    const root = path.resolve("C:\\data\\Hardware");
    expect(isPathInside(root, path.join(root, "config"))).toBe(true);
    expect(isPathInside(root, path.resolve("C:\\data\\Hardware-Other"))).toBe(
      false,
    );
  });
});

describe("desktop window bounds", () => {
  it("clamps restored bounds onto a connected monitor", () => {
    expect(
      clampWindowBounds(
        { x: 5_000, y: 5_000, width: 1_280, height: 800 },
        [{ workArea: { x: 0, y: 0, width: 1_920, height: 1_040 } }],
        { x: 100, y: 100, width: 1_280, height: 800 },
      ),
    ).toEqual({ x: 640, y: 240, width: 1_280, height: 800 });
  });
});
