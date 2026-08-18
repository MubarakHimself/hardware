import { pathToFileURL } from "node:url";

type UtilityParentPort = {
  on(
    event: "message",
    listener: (event: { data?: unknown }) => void,
  ): void;
};

const parentPort = (
  process as NodeJS.Process & { parentPort?: UtilityParentPort }
).parentPort;

parentPort?.on("message", (event) => {
  const message = event.data;
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "hardware:stop"
  ) {
    process.emit("SIGTERM", "SIGTERM");
  }
});

const target = process.argv[2];
if (!target) {
  throw new Error("The Hardware utility target is missing.");
}

await import(pathToFileURL(target).href);

