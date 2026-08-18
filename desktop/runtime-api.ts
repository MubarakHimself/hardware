import {
  activeWorkResponseSchema,
  drainResponseSchema,
  runtimeReadyResponseSchema,
} from "./schemas";
import type { ActiveWork } from "./types";

export class DesktopRuntimeApi {
  #origin?: string;
  readonly #sessionToken: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    sessionToken: string;
    fetch?: typeof fetch;
  }) {
    this.#sessionToken = options.sessionToken;
    this.#fetch = options.fetch ?? fetch;
  }

  setOrigin(origin: string): void {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      !parsed.port
    ) {
      throw new Error("The desktop API origin must use numeric loopback.");
    }
    this.#origin = parsed.origin;
  }

  get origin(): string | undefined {
    return this.#origin;
  }

  async isReady(): Promise<boolean> {
    try {
      const response = await this.#request("/api/internal/runtime/ready", {
        method: "GET",
      });
      if (!response.ok) return false;
      runtimeReadyResponseSchema.parse(await response.json());
      return true;
    } catch {
      return false;
    }
  }

  async activeWork(): Promise<ActiveWork> {
    const response = await this.#request(
      "/api/internal/runtime/active-work",
      { method: "GET" },
    );
    if (!response.ok) throw new Error("Active work could not be read.");
    return activeWorkResponseSchema.parse(await response.json()).data;
  }

  async setDraining(draining: boolean): Promise<boolean> {
    const response = await this.#request("/api/internal/runtime/drain", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: this.#requiredOrigin(),
      },
      body: JSON.stringify({ draining }),
    });
    if (!response.ok) throw new Error("Drain mode could not be changed.");
    return drainResponseSchema.parse(await response.json()).data.draining;
  }

  async #request(pathname: string, init: RequestInit): Promise<Response> {
    const origin = this.#requiredOrigin();
    return this.#fetch(new URL(pathname, origin), {
      ...init,
      headers: {
        authorization: `Bearer ${this.#sessionToken}`,
        ...init.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
  }

  #requiredOrigin(): string {
    if (!this.#origin) throw new Error("The desktop API is not running.");
    return this.#origin;
  }
}

