import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const outputDirectory = join(repositoryRoot, "build", "desktop");
const tsupCli = join(
  repositoryRoot,
  "node_modules",
  "tsup",
  "dist",
  "cli-default.js",
);

function runTsup(arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [tsupCli, ...arguments_],
      {
        cwd: repositoryRoot,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`tsup exited with status ${code}.`));
      }
    });
  });
}

async function normalizeOutput(preferred, alternatives) {
  try {
    await access(preferred);
    return;
  } catch {
    // Try tsup's format-sensitive extension before failing.
  }

  for (const alternative of alternatives) {
    try {
      await access(alternative);
      await rename(alternative, preferred);
      return;
    } catch {
      // Continue to the next supported tsup output name.
    }
  }

  throw new Error(`Desktop compilation did not create ${preferred}.`);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await runTsup([
  "./desktop/main.ts",
  "./desktop/utility-host.ts",
  "--format",
  "esm",
  "--platform",
  "node",
  "--target",
  "node24",
  "--out-dir",
  "build/desktop",
  "--no-splitting",
  "--external",
  "electron",
]);
await normalizeOutput(join(outputDirectory, "main.js"), [
  join(outputDirectory, "main.mjs"),
]);
await normalizeOutput(join(outputDirectory, "utility-host.js"), [
  join(outputDirectory, "utility-host.mjs"),
]);

await runTsup([
  "./desktop/preload.ts",
  "--format",
  "cjs",
  "--platform",
  "node",
  "--target",
  "node24",
  "--out-dir",
  "build/desktop",
  "--no-splitting",
  "--external",
  "electron",
]);
await normalizeOutput(join(outputDirectory, "preload.cjs"), [
  join(outputDirectory, "preload.js"),
]);

const rootPackage = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
await writeFile(
  join(outputDirectory, "package.json"),
  `${JSON.stringify(
    {
      name: "hardware-desktop",
      version: rootPackage.version,
      private: true,
      type: "module",
      main: "main.js",
      description: rootPackage.description,
      author: rootPackage.author,
      homepage: rootPackage.homepage,
      repository: rootPackage.repository,
      license: rootPackage.license,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`Electron entry points are ready in ${outputDirectory}.`);
