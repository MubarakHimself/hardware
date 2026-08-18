import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const lockPath = join(
  repositoryRoot,
  "resources",
  "postgres",
  "provenance.lock.json",
);

function parseArguments(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }

    const equals = argument.indexOf("=");
    if (equals >= 0) {
      parsed.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }

    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      parsed.set(key, "true");
      continue;
    }

    parsed.set(key, value);
    index += 1;
  }
  return parsed;
}

function normalizeArchitecture(value) {
  if (value === "x64" || value === "amd64" || value === "x86_64") {
    return "x64";
  }
  throw new Error(`Unsupported PostgreSQL architecture: ${value}`);
}

function assertInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  if (
    pathFromParent === "" ||
    pathFromParent === "." ||
    pathFromParent.startsWith(`..${sep}`) ||
    pathFromParent === ".." ||
    resolve(candidate) === resolve(parent)
  ) {
    throw new Error(`Refusing unsafe generated path: ${candidate}`);
  }
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  const temporaryPath = `${destination}.partial`;
  await rm(temporaryPath, { force: true });

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `PostgreSQL download failed with HTTP ${response.status} ${response.statusText}`,
    );
  }

  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(temporaryPath, { flags: "wx" }),
  );
  await rename(temporaryPath, destination);
}

async function verifyArchive(path, target) {
  const archiveStat = await stat(path);
  if (archiveStat.size !== target.size) {
    throw new Error(
      `PostgreSQL archive length mismatch: expected ${target.size}, received ${archiveStat.size}`,
    );
  }

  const actualHash = await sha256(path);
  if (actualHash !== target.sha256) {
    throw new Error(
      `PostgreSQL archive SHA-256 mismatch: expected ${target.sha256}, received ${actualHash}`,
    );
  }
}

function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            `${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

const arguments_ = parseArguments(process.argv.slice(2));
const platform = arguments_.get("platform") ?? process.platform;
const architecture = normalizeArchitecture(
  arguments_.get("arch") ?? process.arch,
);
const targetKey = `${platform}-${architecture}`;

if (targetKey !== "win32-x64") {
  throw new Error(
    `The archive acquisition script supports win32-x64; use scripts/desktop/build-postgres-linux.sh for ${targetKey}.`,
  );
}

const provenance = JSON.parse(await readFile(lockPath, "utf8"));
const target = provenance.postgresql.targets[targetKey];
if (!target) {
  throw new Error(`No PostgreSQL provenance entry exists for ${targetKey}.`);
}

const cacheDirectory = join(repositoryRoot, ".desktop-cache");
await mkdir(cacheDirectory, { recursive: true });
const archivePath = arguments_.has("archive")
  ? resolve(arguments_.get("archive"))
  : join(cacheDirectory, target.fileName);

if (!(await exists(archivePath))) {
  if (arguments_.has("archive")) {
    throw new Error(`Supplied PostgreSQL archive does not exist: ${archivePath}`);
  }
  console.log(`Downloading PostgreSQL ${provenance.postgresql.version}...`);
  await download(target.url, archivePath);
}

console.log(`Verifying ${archivePath}...`);
await verifyArchive(archivePath, target);

const vendorRoot = join(repositoryRoot, "vendor", "postgres");
const destination = join(vendorRoot, targetKey);
const stagingRoot = join(vendorRoot, `.${targetKey}-${process.pid}.staging`);
assertInside(join(repositoryRoot, "vendor"), destination);
assertInside(join(repositoryRoot, "vendor"), stagingRoot);

await mkdir(vendorRoot, { recursive: true });
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });

try {
  const selectedArchivePaths = target.selectedPaths.map(
    (path) => `${target.archiveRoot}/${path}`,
  );
  await run("tar", [
    "-xf",
    archivePath,
    "-C",
    stagingRoot,
    ...selectedArchivePaths,
  ]);

  const extractedRoot = join(stagingRoot, target.archiveRoot);
  const requiredFiles = [
    "bin/postgres.exe",
    "bin/initdb.exe",
    "bin/pg_ctl.exe",
    "bin/pg_dump.exe",
    "bin/pg_restore.exe",
    "bin/pg_isready.exe",
    "lib/pg_trgm.dll",
    "share/extension/pg_trgm.control",
  ];
  await Promise.all(
    requiredFiles.map((path) => access(join(extractedRoot, path))),
  );

  const versionResult = await run(
    join(extractedRoot, "bin", "postgres.exe"),
    ["--version"],
    { capture: true },
  );
  if (!versionResult.stdout.includes(provenance.postgresql.version)) {
    throw new Error(
      `Extracted postgres reported an unexpected version: ${versionResult.stdout.trim()}`,
    );
  }

  await writeFile(
    join(extractedRoot, "PROVENANCE.json"),
    `${JSON.stringify(
      {
        schemaVersion: provenance.schemaVersion,
        postgresql: {
          version: provenance.postgresql.version,
          major: provenance.postgresql.major,
          license: provenance.postgresql.license,
          target: targetKey,
          source: target,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await rm(destination, { recursive: true, force: true });
  await rename(extractedRoot, destination);
  console.log(
    `PostgreSQL ${provenance.postgresql.version} is ready at ${destination}.`,
  );
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
