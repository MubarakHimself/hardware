import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  ManagedUtilityProcess,
  type UtilityForkOptions,
  type UtilityProcessAdapter,
  type UtilityProcessLike,
} from "../../desktop/utility-process";
import { inheritedOsEnvironment } from "../../desktop/runtime";

class FakeUtilityProcess extends EventEmitter implements UtilityProcessLike {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
    queueMicrotask(() => this.emit("exit", 0));
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 1);
    return true;
  }
}

describe("Electron utility process supervision", () => {
  it("forks the utility host without ELECTRON_RUN_AS_NODE", async () => {
    const child = new FakeUtilityProcess();
    let captured:
      | {
          modulePath: string;
          arguments_: readonly string[];
          options: UtilityForkOptions;
        }
      | undefined;
    const adapter: UtilityProcessAdapter = {
      fork(modulePath, arguments_, options) {
        captured = { modulePath, arguments_, options };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    };
    const managed = new ManagedUtilityProcess(
      {
        name: "worker",
        hostModule: "utility-host.js",
        targetModule: "worker.js",
        cwd: "C:\\Hardware",
        environment: { NODE_ENV: "production" },
      },
      { adapter },
    );

    await managed.start();
    expect(captured).toMatchObject({
      modulePath: "utility-host.js",
      arguments_: ["worker.js"],
      options: { env: { NODE_ENV: "production" } },
    });
    expect(captured?.options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    await managed.stop();
    expect(child.messages).toContainEqual({ type: "hardware:stop" });
    expect(child.killed).toBe(false);
  });

  it("does not inherit ambient secrets or Node injection flags", () => {
    const inherited = inheritedOsEnvironment({
      NODE_ENV: "production",
      PATH: "C:\\Windows\\System32",
      NODE_OPTIONS: "--require malicious.js",
      YOUTUBE_API_KEY: "ambient-secret",
      GITHUB_TOKEN: "ambient-token",
    });

    expect(inherited).toEqual({ PATH: "C:\\Windows\\System32" });
  });
});

