import "server-only";
import { z } from "zod";
import type { UserRole } from "../domain";
import { DEFAULT_LOCAL_OWNER_ID } from "./local-identity";

export class ServerConfigurationError extends Error {
  constructor(message = "The server is not configured for this runtime.") {
    super(message);
    this.name = "ServerConfigurationError";
  }
}

type RuntimeBase = {
  appOrigin: string;
  releaseSha: string;
};

export type ServerConfig =
  | (RuntimeBase & {
      mode: "demo";
      demoRole: UserRole;
    })
  | (RuntimeBase & {
      mode: "local";
      databaseUrl: string;
      localOwnerId: string;
      localOwnerName: string;
      healthcheckToken: string;
      desktopSessionToken?: string;
      youtubeApiKey?: string;
      githubToken?: string;
    });

const placeholderHealthcheckTokens = new Set([
  "replacewithalongrandomvalue",
  "replacewithasecurehealthchecktoken",
  "yourhealthchecktokenhere",
]);

const healthcheckToken = z
  .string()
  .trim()
  .min(32)
  .max(512)
  .regex(/^\S+$/)
  .refine((value) => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (
      !placeholderHealthcheckTokens.has(normalized) &&
      !/^(.)\1+$/.test(value)
    );
  });

function loopbackOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1";
  if (!loopback || url.protocol !== "http:" || url.username || url.password) {
    return null;
  }
  return url.origin;
}

export function getServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const common = z
    .object({
      NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
      APP_MODE: z.enum(["local", "demo"]).default("local"),
      DEMO_USER_ROLE: z.enum(["member", "admin"]).default("admin"),
      NEXT_PUBLIC_APP_URL: z
        .string()
        .trim()
        .default("http://127.0.0.1:3000"),
      RELEASE_SHA: z.string().trim().min(1).max(160).default("development"),
    })
    .safeParse(environment);

  if (!common.success) {
    throw new ServerConfigurationError();
  }

  const appOrigin = loopbackOrigin(common.data.NEXT_PUBLIC_APP_URL);
  if (!appOrigin) {
    throw new ServerConfigurationError(
      "NEXT_PUBLIC_APP_URL must be an HTTP loopback URL.",
    );
  }

  if (common.data.APP_MODE === "demo") {
    if (common.data.NODE_ENV === "production") {
      throw new ServerConfigurationError(
        "APP_MODE=demo must never be enabled in production.",
      );
    }
    return {
      mode: "demo",
      demoRole: common.data.DEMO_USER_ROLE,
      appOrigin,
      releaseSha: common.data.RELEASE_SHA,
    };
  }

  const configured = z
    .object({
      DATABASE_URL: z.string().url().startsWith("postgresql://"),
      // Personal Local has one durable identity. Accepting an arbitrary UUID
      // here could create a second owner and make migrated personal data appear
      // to disappear, so an explicit value must also be the stable owner ID.
      LOCAL_OWNER_ID: z
        .literal(DEFAULT_LOCAL_OWNER_ID)
        .default(DEFAULT_LOCAL_OWNER_ID),
      LOCAL_OWNER_NAME: z.string().trim().min(1).max(160).default("Local owner"),
      HEALTHCHECK_TOKEN: healthcheckToken,
      DESKTOP_SESSION_TOKEN: z.preprocess(
        (value) =>
          typeof value === "string" && value.trim() === ""
            ? undefined
            : value,
        healthcheckToken.optional(),
      ),
      YOUTUBE_API_KEY: z.preprocess(
        (value) =>
          typeof value === "string" && value.trim() === ""
            ? undefined
            : value,
        z.string().trim().min(20).max(512).optional(),
      ),
      GITHUB_TOKEN: z.preprocess(
        (value) =>
          typeof value === "string" && value.trim() === ""
            ? undefined
            : value,
        z.string().trim().min(1).max(512).optional(),
      ),
    })
    .safeParse({
      ...environment,
      HEALTHCHECK_TOKEN:
        environment.HEALTHCHECK_TOKEN ?? environment.DESKTOP_SESSION_TOKEN,
    });

  if (!configured.success) {
    throw new ServerConfigurationError();
  }

  return {
    mode: "local",
    databaseUrl: configured.data.DATABASE_URL,
    localOwnerId: configured.data.LOCAL_OWNER_ID,
    localOwnerName: configured.data.LOCAL_OWNER_NAME,
    appOrigin,
    healthcheckToken: configured.data.HEALTHCHECK_TOKEN,
    desktopSessionToken: configured.data.DESKTOP_SESSION_TOKEN,
    youtubeApiKey: configured.data.YOUTUBE_API_KEY,
    githubToken: configured.data.GITHUB_TOKEN,
    releaseSha: common.data.RELEASE_SHA,
  };
}

export function isDemoMode(): boolean {
  return getServerConfig().mode === "demo";
}
