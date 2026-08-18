import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const npmCli = process.env.npm_execpath;
const useNodeForNpm = process.platform === "win32" && Boolean(npmCli);
const npmCommand = useNodeForNpm ? process.execPath : "npm";
const npmPrefix = useNodeForNpm ? [npmCli] : [];
const scripts = [
  "build",
  "desktop:compile",
  "desktop:runtime",
  "desktop:icons",
  "desktop:check",
  "desktop:scan",
];

function runScript(script) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(npmCommand, [...npmPrefix, "run", script], {
      cwd: repositoryRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`npm run ${script} exited with status ${code}.`));
      }
    });
  });
}

for (const script of scripts) {
  await runScript(script);
}
