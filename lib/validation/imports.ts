import { z } from "zod";
import type { ImportCommand } from "../domain";
import {
  getGitHubRepositoryIdentity,
  getYouTubeChannelImportIdentity,
  getYouTubeVideoId,
  isSafeImportUrlSyntax,
  isUnsupportedSocialVideoUrl,
  isYouTubeUrl,
} from "./public-url";

const importUrl = z
  .string()
  .trim()
  .min(1, "URL is required.")
  .max(2_048, "URL must not exceed 2048 characters.")
  .refine(isSafeImportUrlSyntax, "Enter a public HTTP(S) URL without credentials.");

export const importRequestSchema: z.ZodType<ImportCommand> = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("youtube_video"),
        url: importUrl.refine(
          (url) => getYouTubeVideoId(url) !== null,
          "Enter a supported YouTube video URL.",
        ),
      })
      .strict(),
    z
      .object({
        kind: z.literal("youtube_channel"),
        url: importUrl.refine(
          (url) => getYouTubeChannelImportIdentity(url) !== null,
          "Enter a supported YouTube /channel/ID or @handle URL.",
        ),
      })
      .strict(),
    z
      .object({
        kind: z.literal("github_repository"),
        url: importUrl.refine(
          (url) => getGitHubRepositoryIdentity(url) !== null,
          "Enter an exact public GitHub repository URL.",
        ),
      })
      .strict(),
    z
      .object({
        kind: z.literal("website"),
        url: importUrl
          .refine(
            (url) => !isYouTubeUrl(url),
            "Only individual videos can be imported from YouTube.",
          )
          .refine(
            (url) => getGitHubRepositoryIdentity(url) === null,
            "Use the GitHub repository import type for this URL.",
          )
          .refine(
            (url) => !isUnsupportedSocialVideoUrl(url),
            "Instagram and other social-video imports are not supported yet.",
          ),
      })
      .strict(),
  ]);

export function parseImportRequest(input: unknown): ImportCommand {
  return importRequestSchema.parse(input);
}
