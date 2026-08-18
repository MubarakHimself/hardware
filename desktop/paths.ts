import { mkdir, realpath } from "node:fs/promises";
import { homedir as systemHomeDirectory } from "node:os";
import path from "node:path";

export interface RuntimePaths {
  profileRoots: string[];
  root: string;
  data: string;
  postgresData: string;
  config: string;
  logs: string;
  crashDumps: string;
  runtime: string;
  recovery: string;
  settingsFile: string;
  vaultFile: string;
  operationJournal: string;
  defaultBackupDirectory: string;
}

export interface RuntimePathOptions {
  platform?: NodeJS.Platform;
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  documentsDirectory?: string;
}

function configuredOrDefault(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  return path.resolve(trimmed || fallback);
}

export function resolveRuntimePaths(
  options: RuntimePathOptions = {},
): RuntimePaths {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? systemHomeDirectory();
  const documentsDirectory =
    options.documentsDirectory ?? path.join(homeDirectory, "Documents");

  if (platform === "win32") {
    const localAppData = configuredOrDefault(
      environment.LOCALAPPDATA,
      path.join(homeDirectory, "AppData", "Local"),
    );
    const root = path.join(localAppData, "Hardware");
    const config = path.join(root, "config");
    const runtime = path.join(root, "runtime");
    return {
      profileRoots: [root],
      root,
      data: path.join(root, "data"),
      postgresData: path.join(root, "data", "postgres"),
      config,
      logs: path.join(root, "logs"),
      crashDumps: path.join(root, "crash-dumps"),
      runtime,
      recovery: path.join(root, "recovery"),
      settingsFile: path.join(config, "settings.json"),
      vaultFile: path.join(config, "credentials.vault"),
      operationJournal: path.join(runtime, "operation.json"),
      defaultBackupDirectory: path.join(
        documentsDirectory,
        "Hardware Backups",
      ),
    };
  }

  const dataRoot = configuredOrDefault(
    environment.XDG_DATA_HOME,
    path.join(homeDirectory, ".local", "share"),
  );
  const configRoot = configuredOrDefault(
    environment.XDG_CONFIG_HOME,
    path.join(homeDirectory, ".config"),
  );
  const stateRoot = configuredOrDefault(
    environment.XDG_STATE_HOME,
    path.join(homeDirectory, ".local", "state"),
  );
  const runtimeRoot = configuredOrDefault(
    environment.XDG_RUNTIME_DIR,
    path.join(stateRoot, "runtime"),
  );
  const data = path.join(dataRoot, "hardware");
  const config = path.join(configRoot, "hardware");
  const state = path.join(stateRoot, "hardware");
  const runtime = path.join(runtimeRoot, "hardware");
  return {
    profileRoots: [data, config, state, runtime],
    root: data,
    data,
    postgresData: path.join(data, "postgres"),
    config,
    logs: path.join(state, "logs"),
    crashDumps: path.join(state, "crash-dumps"),
    runtime,
    recovery: path.join(state, "recovery"),
    settingsFile: path.join(config, "settings.json"),
    vaultFile: path.join(config, "credentials.vault"),
    operationJournal: path.join(runtime, "operation.json"),
    defaultBackupDirectory: path.join(documentsDirectory, "Hardware Backups"),
  };
}

export function validateEraseTarget(target: string): string {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const leaf = path.basename(resolved).toLowerCase();
  if (
    resolved === parsed.root ||
    resolved === path.resolve(systemHomeDirectory()) ||
    !["hardware"].includes(leaf)
  ) {
    throw new Error("Refusing to erase an unsafe profile path.");
  }
  return resolved;
}

export async function ensureRuntimePaths(paths: RuntimePaths): Promise<void> {
  const directories = [
    paths.root,
    paths.data,
    paths.postgresData,
    paths.config,
    paths.logs,
    paths.crashDumps,
    paths.runtime,
    paths.recovery,
    paths.defaultBackupDirectory,
  ];
  await Promise.all(
    directories.map((directory) =>
      mkdir(directory, {
        recursive: true,
        mode: process.platform === "win32" ? undefined : 0o700,
      }),
    ),
  );
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function assertExistingPathInside(
  parent: string,
  candidate: string,
): Promise<string> {
  const [realParent, realCandidate] = await Promise.all([
    realpath(parent),
    realpath(candidate),
  ]);
  if (!isPathInside(realParent, realCandidate)) {
    throw new Error("The selected path is outside the permitted directory.");
  }
  return realCandidate;
}
