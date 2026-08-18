import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const builderConfiguration = await readFile(
  join(repositoryRoot, "electron-builder.yml"),
  "utf8",
);
const provenance = JSON.parse(
  await readFile(
    join(repositoryRoot, "resources", "postgres", "provenance.lock.json"),
    "utf8",
  ),
);

const failures = [];
function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

check(
  ["0.2.0-alpha.1", "0.2.0-alpha.2"].includes(packageJson.version),
  "package version must be the Windows alpha.1 or Ubuntu-enabling alpha.2 milestone",
);
check(
  packageJson.main === "build/desktop/main.js",
  "package main must point at build/desktop/main.js",
);
check(
  packageJson.devDependencies.electron === "43.2.0",
  "Electron must be pinned to 43.2.0",
);
check(
  packageJson.devDependencies["electron-builder"] === "26.15.3",
  "electron-builder must be pinned to 26.15.3",
);
check(
  builderConfiguration.includes("appId: com.mubarak.hardware"),
  "electron-builder appId is missing",
);
check(
  builderConfiguration.includes("to: postgres/win32-x64"),
  "Windows PostgreSQL extraResource is missing",
);
check(
  builderConfiguration.includes("to: postgres/linux-x64"),
  "Linux PostgreSQL extraResource is missing",
);
check(
  builderConfiguration.includes("deleteAppDataOnUninstall: false"),
  "installer must preserve user data on uninstall",
);
check(
  builderConfiguration.includes("runAsNode: false") &&
    builderConfiguration.includes("onlyLoadAppFromAsar: true"),
  "Electron fuse hardening is missing",
);
check(
  provenance.postgresql.version === "17.10",
  "PostgreSQL must remain pinned to 17.10",
);

for (const [targetName, target] of Object.entries(
  provenance.postgresql.targets,
)) {
  check(
    /^https:\/\//.test(target.url),
    `${targetName} PostgreSQL URL must use HTTPS`,
  );
  check(
    /^[a-f0-9]{64}$/.test(target.sha256),
    `${targetName} PostgreSQL SHA-256 is not pinned`,
  );
  check(
    Number.isSafeInteger(target.size) && target.size > 0,
    `${targetName} PostgreSQL archive length is not pinned`,
  );
}

const requiredSourceFiles = [
  "desktop/main.ts",
  "desktop/preload.ts",
  "desktop/utility-host.ts",
  "build/icons/icon.svg",
  "scripts/desktop/after-pack.cjs",
  "scripts/desktop/acquire-postgres.mjs",
];
for (const relativePath of requiredSourceFiles) {
  try {
    await access(join(repositoryRoot, relativePath));
  } catch {
    failures.push(`required desktop source is missing: ${relativePath}`);
  }
}

if (failures.length > 0) {
  throw new Error(
    `Desktop configuration check failed:\n- ${failures.join("\n- ")}`,
  );
}

console.log(
  "Desktop configuration is pinned for Electron 43.2.0, electron-builder 26.15.3, and PostgreSQL 17.10.",
);
