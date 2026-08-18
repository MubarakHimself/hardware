import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const arguments_ = process.argv.slice(2);
const suppliedRoots = [];
for (let index = 0; index < arguments_.length; index += 1) {
  if (arguments_[index] !== "--root" || !arguments_[index + 1]) {
    throw new Error("Package scan accepts repeated --root <directory> pairs.");
  }
  suppliedRoots.push(resolve(arguments_[index + 1]));
  index += 1;
}

const roots =
  suppliedRoots.length > 0
    ? suppliedRoots
    : [
        join(repositoryRoot, "build", "runtime"),
        join(repositoryRoot, "build", "desktop"),
      ];

const forbiddenExactNames = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "PG_VERSION",
  "postmaster.opts",
  "postmaster.pid",
  "backup.key",
]);
const forbiddenExtensions = new Set([
  ".map",
  ".pem",
  ".dump",
  ".sqlite",
  ".sqlite3",
]);
const inspectTextExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".txt",
  ".yaml",
  ".yml",
]);
const forbiddenTextPatterns = [
  {
    label: "Windows developer path",
    expression: /[A-Za-z]:\\Users\\[^\\\s"'`]+\\/,
  },
  {
    label: "macOS developer path",
    expression: /\/Users\/[^/\s"'`]+\//,
  },
  {
    label: "Linux developer path",
    expression: /\/home\/[^/\s"'`]+\//,
  },
  {
    label: "private key",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    label: "YouTube API credential",
    expression: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    label: "GitHub credential",
    expression: /\bgithub_pat_[0-9A-Za-z_]{30,}\b|\bgh[pousr]_[0-9A-Za-z]{30,}\b/,
  },
  {
    label: "nonempty provider assignment",
    expression:
      /(?:YOUTUBE_API_KEY|GITHUB_TOKEN|POSTGRES_PASSWORD|BACKUP_KEY)\s*=\s*["']?[^"'\s;]{8,}/,
  },
];

const failures = [];

function isInsideRepositoryOrGeneratedVendor(path) {
  const relativePath = path.slice(repositoryRoot.length);
  return (
    path === repositoryRoot ||
    (path.startsWith(repositoryRoot) &&
      (relativePath.startsWith(sep) || relativePath === ""))
  );
}

async function inspectFile(path) {
  const name = basename(path);
  const lowerName = name.toLowerCase();
  const extension = extname(name);
  if (
    forbiddenExactNames.has(name) ||
    forbiddenExactNames.has(lowerName) ||
    forbiddenExtensions.has(extension) ||
    lowerName.endsWith(".hardware-backup") ||
    lowerName.endsWith(".dump.enc") ||
    lowerName.endsWith(".key")
  ) {
    failures.push(`forbidden packaged file: ${path}`);
    return;
  }

  if (!inspectTextExtensions.has(extension.toLowerCase())) {
    return;
  }

  const fileStat = await lstat(path);
  if (fileStat.size > 4 * 1024 * 1024) {
    return;
  }

  const contents = await readFile(path, "utf8");
  for (const pattern of forbiddenTextPatterns) {
    if (pattern.expression.test(contents)) {
      failures.push(`${pattern.label} found in ${path}`);
    }
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      failures.push(`symbolic link is not allowed in packaged input: ${path}`);
    } else if (entry.isDirectory()) {
      await walk(path);
    } else if (entry.isFile()) {
      await inspectFile(path);
    }
  }
}

for (const root of roots) {
  if (!isInsideRepositoryOrGeneratedVendor(root)) {
    throw new Error(`Refusing to scan outside the repository: ${root}`);
  }
  await walk(root);
}

if (failures.length > 0) {
  throw new Error(`Desktop package-content scan failed:\n- ${failures.join("\n- ")}`);
}

console.log(`Desktop package-content scan passed for ${roots.length} root(s).`);
