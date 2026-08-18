import { z } from "zod";

export const providerNameSchema = z.enum(["youtube", "github"]);

export const providerCredentialInputSchema = z
  .object({
    provider: providerNameSchema,
    credential: z.string().trim().min(1).max(512),
  })
  .superRefine((input, context) => {
    if (input.provider === "youtube" && input.credential.length < 20) {
      context.addIssue({
        code: "custom",
        path: ["credential"],
        message: "The YouTube API key is too short.",
      });
    }
  });

export const vaultPassphraseSchema = z
  .string()
  .min(12)
  .max(1024)
  .refine((value) => !/^(.)\1+$/.test(value), {
    message: "Choose a less repetitive vault passphrase.",
  });

export const eraseConfirmationSchema = z.literal("ERASE");

export const desktopPreferencesUpdateSchema = z
  .object({
    onboardingCompleted: z.boolean().optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one desktop preference is required.",
  });

export const backupDirectorySchema = z.string().trim().min(1).max(4096);

export const runtimeReadyResponseSchema = z.object({
  data: z.object({
    status: z.literal("ready"),
    database: z.literal("ready"),
    worker: z.literal("ready"),
    catalog: z.literal("ready"),
    draining: z.boolean(),
    release: z.string(),
  }),
});

export const activeWorkResponseSchema = z.object({
  data: z.object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    byType: z.array(
      z.object({
        type: z.string().min(1).max(160),
        queued: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
      }),
    ),
  }),
});

export const drainResponseSchema = z.object({
  data: z.object({ draining: z.boolean() }),
});
