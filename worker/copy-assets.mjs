import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist-worker/", import.meta.url), { recursive: true });
await copyFile(
  new URL("./crontab", import.meta.url),
  new URL("../dist-worker/crontab", import.meta.url),
);
