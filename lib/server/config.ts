import "server-only";
import { z } from "zod";
import type { UserRole } from "../domain";

export class ServerConfigurationError extends Error {
  constructor(message = "The server is not configured for this runtime.") {
    super(message);
    this.name = "ServerConfigurationError";
  }
}

export type ServerConfig =
  | {
      mode: "demo";
      demoRole: UserRole;
      releaseSha: string;
    }
  | {
      mode: "production";
      databaseUrl: string;
      clerkPublishableKey: string;
      clerkSecretKey: string;
      clerkWebhookSigningSecret: string;
      adminClerkUserIds: readonly string[];
      appOrigin: string;
      healthcheckToken: string;
      youtubeApiKey: string;
      githubToken?: string;
      releaseSha: string;
    };

const booleanFlag = z.enum(["true", "false"]).default("false");

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

export function getServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const common = z
    .object({
      NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
      DEMO_MODE: booleanFlag,
      DEMO_USER_ROLE: z.enum(["member", "admin"]).default("admin"),
      RELEASE_SHA: z.string().trim().min(1).max(160).default("development"),
    })
    .safeParse(environment);

  if (!common.success) {
    throw new ServerConfigurationError();
  }

  const demoMode = common.data.DEMO_MODE === "true";
  if (demoMode) {
    if (common.data.NODE_ENV === "production") {
      throw new ServerConfigurationError(
        "DEMO_MODE must never be enabled in production.",
      );
    }
    return {
      mode: "demo",
      demoRole: common.data.DEMO_USER_ROLE,
      releaseSha: common.data.RELEASE_SHA,
    };
  }

  const appUrl = z.string().url().superRefine((value, context) => {
    const protocol = new URL(value).protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "NEXT_PUBLIC_APP_URL must use HTTP(S).",
      });
    }
    if (common.data.NODE_ENV === "production" && protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "NEXT_PUBLIC_APP_URL must use HTTPS in production.",
      });
    }
  });

  const configured = z
    .object({
      DATABASE_URL: z.string().url().startsWith("postgresql://"),
      NEXT_PUBLIC_APP_URL: appUrl,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().trim().min(20),
      CLERK_SECRET_KEY: z.string().trim().min(20),
      CLERK_WEBHOOK_SIGNING_SECRET: z.string().trim().startsWith("whsec_").min(20),
      ADMIN_CLERK_USER_IDS: z
        .string()
        .trim()
        .transform((value) =>
          [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))],
        )
        .pipe(z.array(z.string().startsWith("user_").max(128)).min(1)),
      HEALTHCHECK_TOKEN: healthcheckToken,
      YOUTUBE_API_KEY: z.string().trim().min(20).max(512),
      GITHUB_TOKEN: z.preprocess(
        (value) =>
          typeof value === "string" && value.trim() === ""
            ? undefined
            : value,
        z.string().trim().min(1).max(512).optional(),
      ),
    })
    .safeParse(environment);

  if (!configured.success) {
    throw new ServerConfigurationError();
  }

  return {
    mode: "production",
    databaseUrl: configured.data.DATABASE_URL,
    appOrigin: new URL(configured.data.NEXT_PUBLIC_APP_URL).origin,
    clerkPublishableKey: configured.data.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    clerkSecretKey: configured.data.CLERK_SECRET_KEY,
    clerkWebhookSigningSecret: configured.data.CLERK_WEBHOOK_SIGNING_SECRET,
    adminClerkUserIds: configured.data.ADMIN_CLERK_USER_IDS,
    healthcheckToken: configured.data.HEALTHCHECK_TOKEN,
    youtubeApiKey: configured.data.YOUTUBE_API_KEY,
    githubToken: configured.data.GITHUB_TOKEN,
    releaseSha: common.data.RELEASE_SHA,
  };
}

export function isDemoMode(): boolean {
  return getServerConfig().mode === "demo";
}
