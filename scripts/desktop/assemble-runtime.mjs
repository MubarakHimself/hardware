import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const standaloneDirectory = join(repositoryRoot, ".next", "standalone");
const finalDirectory = join(repositoryRoot, "build", "runtime");
const stagingDirectory = join(repositoryRoot, "build", ".runtime.staging");

async function requirePath(path, explanation) {
  try {
    await access(path);
  } catch {
    throw new Error(`${explanation}: ${path}`);
  }
}

async function removeSourceMaps(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await removeSourceMaps(path);
      } else if (entry.isFile() && entry.name.endsWith(".map")) {
        await rm(path, { force: true });
      }
    }),
  );
}

await requirePath(
  join(standaloneDirectory, "server.js"),
  "Next standalone server is missing; run npm run build first",
);
await requirePath(
  join(repositoryRoot, "dist-worker", "index.js"),
  "Compiled worker is missing",
);
await requirePath(
  join(repositoryRoot, "dist-worker", "crontab"),
  "Compiled worker crontab is missing",
);
await requirePath(
  join(repositoryRoot, "dist-db", "migrate.js"),
  "Compiled migration utility is missing",
);

await rm(stagingDirectory, { recursive: true, force: true });
await mkdir(stagingDirectory, { recursive: true });

try {
  await cp(standaloneDirectory, stagingDirectory, { recursive: true });
  await cp(join(repositoryRoot, "public"), join(stagingDirectory, "public"), {
    recursive: true,
  });
  await cp(
    join(repositoryRoot, ".next", "static"),
    join(stagingDirectory, ".next", "static"),
    { recursive: true },
  );
  await cp(
    join(repositoryRoot, "dist-worker"),
    join(stagingDirectory, "dist-worker"),
    { recursive: true },
  );
  await cp(
    join(repositoryRoot, "dist-db"),
    join(stagingDirectory, "dist-db"),
    { recursive: true },
  );
  await cp(
    join(repositoryRoot, "drizzle"),
    join(stagingDirectory, "drizzle"),
    { recursive: true },
  );
  await removeSourceMaps(stagingDirectory);

  const rootPackage = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const runtimePackagePath = join(stagingDirectory, "package.json");
  const runtimePackage = JSON.parse(await readFile(runtimePackagePath, "utf8"));
  if (runtimePackage.name !== rootPackage.name) {
    throw new Error(
      `Unexpected standalone package identity: ${runtimePackage.name}`,
    );
  }

  await rm(finalDirectory, { recursive: true, force: true });
  await rename(stagingDirectory, finalDirectory);
  console.log(`Desktop backend runtime is ready at ${finalDirectory}.`);
} catch (error) {
  await rm(stagingDirectory, { recursive: true, force: true });
  throw error;
}
