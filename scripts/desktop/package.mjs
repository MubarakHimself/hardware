import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const npmCli = process.env.npm_execpath;
const useNodeForNpm = process.platform === "win32" && Boolean(npmCli);
const npmCommand = useNodeForNpm ? process.execPath : "npm";
const npmPrefix = useNodeForNpm ? [npmCli] : [];
const mode = process.argv[2];
const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);

if (!["--win", "--linux", "--dir"].includes(mode)) {
  throw new Error("Use --win, --linux, or --dir.");
}

function runNpm(arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(npmCommand, [...npmPrefix, ...arguments_], {
      cwd: repositoryRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(`npm ${arguments_.join(" ")} exited with status ${code}.`),
        );
      }
    });
  });
}

let platform;
let builderArguments;
if (mode === "--win") {
  platform = "win32";
  builderArguments = ["--win", "nsis", "zip", "--x64"];
} else if (mode === "--linux") {
  platform = "linux";
  builderArguments = ["--linux", "deb", "AppImage", "--x64"];
} else if (process.platform === "win32") {
  platform = "win32";
  builderArguments = ["--dir", "--win", "--x64"];
} else if (process.platform === "linux") {
  platform = "linux";
  builderArguments = ["--dir", "--linux", "--x64"];
} else {
  throw new Error(`Desktop packaging is unsupported on ${process.platform}.`);
}

if (platform === "linux" && packageJson.version !== "0.2.0-alpha.2") {
  throw new Error(
    "Ubuntu packages are the v0.2.0-alpha.2 milestone. Advance package.json and package-lock.json to 0.2.0-alpha.2 before building them.",
  );
}

if (platform !== process.platform) {
  throw new Error(
    `${platform} desktop artifacts must be built on a ${platform} host.`,
  );
}

const targetKey = `${platform}-x64`;
const postgresDirectory = join(
  repositoryRoot,
  "vendor",
  "postgres",
  targetKey,
);
const postgresExecutable = join(
  postgresDirectory,
  "bin",
  platform === "win32" ? "postgres.exe" : "postgres",
);
try {
  await access(postgresExecutable);
} catch {
  throw new Error(
    `Packaged PostgreSQL is missing at ${postgresDirectory}. Run the matching postgres:acquire script first.`,
  );
}

await runNpm(["run", "desktop:prepare"]);

await runNpm([
  "exec",
  "--",
  "electron-builder",
  "--config",
  "electron-builder.yml",
  ...builderArguments,
]);

await runNpm([
  "run",
  "desktop:scan",
  "--",
  "--root",
  join(repositoryRoot, "build", "runtime"),
  "--root",
  join(repositoryRoot, "build", "desktop"),
  "--root",
  postgresDirectory,
]);
