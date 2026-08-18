import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const arguments_ = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key.startsWith("--") || !value || value.startsWith("--")) {
    throw new Error(`Expected --key value, received ${key}.`);
  }
  arguments_.set(key.slice(2), value);
  index += 1;
}

const platform =
  arguments_.get("platform") ??
  (process.platform === "win32" ? "windows" : process.platform);
if (!["windows", "linux"].includes(platform)) {
  throw new Error(`Unsupported release metadata platform: ${platform}`);
}

const releaseDirectory = resolve(
  arguments_.get("directory") ??
    join(repositoryRoot, "release", "desktop"),
);
await mkdir(releaseDirectory, { recursive: true });

const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const platformLabel = platform === "windows" ? "win-x64" : "linux-x64";
const npmCli = process.env.npm_execpath;
const useNodeForNpm = process.platform === "win32" && Boolean(npmCli);
const npmCommand = useNodeForNpm ? process.execPath : "npm";
const npmPrefix = useNodeForNpm ? [npmCli] : [];
const sbomName = `Hardware-${packageJson.version}-${platformLabel}-sbom.cdx.json`;
const sbom = execFileSync(
  npmCommand,
  [...npmPrefix, "sbom", "--sbom-format", "cyclonedx"],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  },
);
JSON.parse(sbom);
await writeFile(join(releaseDirectory, sbomName), sbom, "utf8");

await copyFile(
  join(repositoryRoot, "docs", "THIRD_PARTY_NOTICES.md"),
  join(releaseDirectory, "THIRD_PARTY_NOTICES.md"),
);
await copyFile(
  join(repositoryRoot, "resources", "postgres", "provenance.lock.json"),
  join(releaseDirectory, "postgres-provenance.lock.json"),
);

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

const releaseFiles = (await readdir(releaseDirectory, { withFileTypes: true }))
  .filter(
    (entry) =>
      entry.isFile() &&
      !entry.name.startsWith("SHA256SUMS-") &&
      extname(entry.name) !== ".yaml",
  )
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

const packagedExtensions =
  platform === "windows" ? new Set([".exe", ".zip"]) : new Set([".deb", ".AppImage"]);
if (!releaseFiles.some((file) => packagedExtensions.has(extname(file)))) {
  throw new Error(
    `No ${platform} desktop packages were found in ${releaseDirectory}.`,
  );
}

const checksumLines = [];
for (const file of releaseFiles) {
  checksumLines.push(`${await sha256(join(releaseDirectory, file))}  ${file}`);
}
await writeFile(
  join(releaseDirectory, `SHA256SUMS-${platformLabel}.txt`),
  `${checksumLines.join("\n")}\n`,
  "utf8",
);

console.log(`Release metadata is ready in ${releaseDirectory}.`);
