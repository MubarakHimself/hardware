import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getServerConfig,
  ServerConfigurationError,
} from "../../lib/server/config";
import { DEFAULT_LOCAL_OWNER_ID } from "../../lib/server/local-identity";

const localEnvironment = {
  NODE_ENV: "production",
  APP_MODE: "local",
  DATABASE_URL: "postgresql://hardware:password@postgres:5432/hardware",
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
  HEALTHCHECK_TOKEN: "unit-test-health-token-7f3c9a2b5d8e1f4a",
  YOUTUBE_API_KEY: "youtube-key-abcdefghijklmnopqrstuvwxyz",
} satisfies NodeJS.ProcessEnv;

describe("server configuration", () => {
  it("defaults persistent identity to one stable local administrator", () => {
    const config = getServerConfig(localEnvironment);

    expect(config).toMatchObject({
      mode: "local",
      appOrigin: "http://127.0.0.1:3000",
      localOwnerId: DEFAULT_LOCAL_OWNER_ID,
      localOwnerName: "Local owner",
    });
    expect(config).not.toHaveProperty("clerkSecretKey");
  });

  it("rejects every alternate local owner ID", () => {
    expect(() =>
      getServerConfig({
        ...localEnvironment,
        LOCAL_OWNER_ID: "00000000-0000-4000-8000-000000000002",
      }),
    ).toThrow(ServerConfigurationError);

    expect(
      getServerConfig({
        ...localEnvironment,
        LOCAL_OWNER_ID: DEFAULT_LOCAL_OWNER_ID,
      }),
    ).toMatchObject({ localOwnerId: DEFAULT_LOCAL_OWNER_ID });
  });

  it("accepts loopback HTTP only and normalizes the configured origin", () => {
    expect(
      getServerConfig({
        ...localEnvironment,
        NEXT_PUBLIC_APP_URL: "http://localhost:3000/path",
      }),
    ).toMatchObject({ appOrigin: "http://localhost:3000" });

    for (const appUrl of [
      "https://hardware.example.test",
      "http://192.168.1.50:3000",
      "https://127.0.0.1:3000",
      "ftp://127.0.0.1:3000",
    ]) {
      expect(() =>
        getServerConfig({ ...localEnvironment, NEXT_PUBLIC_APP_URL: appUrl }),
      ).toThrow(ServerConfigurationError);
    }
  });

  it("keeps demo fixtures explicit and rejects them in production", () => {
    expect(
      getServerConfig({
        APP_MODE: "demo",
        NODE_ENV: "test",
        DEMO_USER_ROLE: "member",
      }),
    ).toMatchObject({
      mode: "demo",
      demoRole: "member",
      appOrigin: "http://127.0.0.1:3000",
    });
    expect(() =>
      getServerConfig({ APP_MODE: "demo", NODE_ENV: "production" }),
    ).toThrow(ServerConfigurationError);
  });

  it("rejects placeholder and repeated-character probe secrets", () => {
    for (const token of ["replace_with_a_long_random_value", "a".repeat(32)]) {
      expect(() =>
        getServerConfig({ ...localEnvironment, HEALTHCHECK_TOKEN: token }),
      ).toThrow(ServerConfigurationError);
    }
  });
});
