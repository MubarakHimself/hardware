import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getServerConfig,
  ServerConfigurationError,
} from "../../lib/server/config";

const productionEnvironment = {
  NODE_ENV: "production",
  DEMO_MODE: "false",
  DATABASE_URL: "postgresql://hardware:password@postgres:5432/hardware",
  NEXT_PUBLIC_APP_URL: "https://hardware.example.test",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abcdefghijklmnopqrstuvwxyz",
  CLERK_SECRET_KEY: "sk_test_abcdefghijklmnopqrstuvwxyz",
  CLERK_WEBHOOK_SIGNING_SECRET: "whsec_abcdefghijklmnopqrstuvwxyz",
  ADMIN_CLERK_USER_IDS: "user_admin1234567890",
  HEALTHCHECK_TOKEN: "unit-test-health-token-7f3c9a2b5d8e1f4a",
  YOUTUBE_API_KEY: "youtube-key-abcdefghijklmnopqrstuvwxyz",
} satisfies NodeJS.ProcessEnv;

describe("server configuration", () => {
  it("accepts only the canonical HTTPS origin in production", () => {
    const config = getServerConfig(productionEnvironment);

    expect(config.mode).toBe("production");
    if (config.mode === "production") {
      expect(config.appOrigin).toBe("https://hardware.example.test");
    }

    expect(() =>
      getServerConfig({
        ...productionEnvironment,
        NEXT_PUBLIC_APP_URL: "http://hardware.example.test",
      }),
    ).toThrow(ServerConfigurationError);
    expect(() =>
      getServerConfig({
        ...productionEnvironment,
        NEXT_PUBLIC_APP_URL: "ftp://hardware.example.test",
      }),
    ).toThrow(ServerConfigurationError);
  });

  it("allows HTTP for local development and treats an empty GitHub token as absent", () => {
    const config = getServerConfig({
      ...productionEnvironment,
      NODE_ENV: "development",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000/path",
      GITHUB_TOKEN: "",
    });

    expect(config).toMatchObject({
      mode: "production",
      appOrigin: "http://127.0.0.1:3000",
      githubToken: undefined,
    });
  });

  it("rejects placeholder and repeated-character probe secrets", () => {
    for (const healthcheckToken of [
      "replace_with_a_long_random_value",
      "a".repeat(32),
    ]) {
      expect(() =>
        getServerConfig({
          ...productionEnvironment,
          HEALTHCHECK_TOKEN: healthcheckToken,
        }),
      ).toThrow(ServerConfigurationError);
    }
  });
});
