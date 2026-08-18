import { connect, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

export async function waitForCondition(
  check: () => Promise<boolean>,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < options.timeoutMs) {
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(options.intervalMs ?? 250, undefined, {
      signal: options.signal,
    });
  }
  throw new Error("The service did not become ready before the deadline.", {
    cause: lastError,
  });
}

export async function canConnectToLoopback(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
