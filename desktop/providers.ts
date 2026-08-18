import type { DesktopSettingsStore } from "./settings";
import type {
  DesktopProvider,
  ProviderCredentialInput,
  ProviderStatus,
  ProviderValidationResult,
} from "./types";
import type { CredentialVault } from "./vault";

export class ProviderAuthenticationError extends Error {
  constructor(provider: DesktopProvider) {
    super(
      `${provider === "youtube" ? "YouTube" : "GitHub"} rejected this credential.`,
    );
    this.name = "ProviderAuthenticationError";
  }
}

export class ProviderCredentialService {
  readonly #vault: CredentialVault;
  readonly #settings: DesktopSettingsStore;
  readonly #fetch: typeof fetch;
  readonly #onChanged: (provider: DesktopProvider) => Promise<void>;

  constructor(options: {
    vault: CredentialVault;
    settings: DesktopSettingsStore;
    fetch?: typeof fetch;
    onChanged: (provider: DesktopProvider) => Promise<void>;
  }) {
    this.#vault = options.vault;
    this.#settings = options.settings;
    this.#fetch = options.fetch ?? fetch;
    this.#onChanged = options.onChanged;
  }

  async statuses(): Promise<ProviderStatus[]> {
    const settings = this.#settings.snapshot();
    return Promise.all(
      (["youtube", "github"] as const).map(async (provider) => {
        const configured = Boolean(await this.#vault.get(vaultKey(provider)));
        const record = settings.providers[provider];
        const verification = !configured
          ? "not_configured"
          : record?.verified
            ? "verified"
            : "unverified";
        return {
          provider,
          label: provider === "youtube" ? "YouTube" : "GitHub",
          configured,
          required: false,
          verification,
          detail:
            verification === "not_configured"
              ? "Not configured. You can add this credential later."
              : verification === "verified"
                ? "Credential verified."
                : "Credential saved but not yet verified.",
          ...(record?.updatedAt
            ? { lastValidatedAt: record.updatedAt }
            : {}),
        } satisfies ProviderStatus;
      }),
    );
  }

  async save(
    input: ProviderCredentialInput,
  ): Promise<ProviderValidationResult> {
    const verificationState = await this.#validate(input);
    await this.#vault.set(vaultKey(input.provider), input.credential);
    const updatedAt = new Date().toISOString();
    await this.#settings.update((current) => ({
      ...current,
      providers: {
        ...current.providers,
        [input.provider]: {
          verified: verificationState === "verified",
          updatedAt,
        },
      },
    }));
    await this.#onChanged(input.provider);
    return {
      provider: input.provider,
      configured: true,
      verification: verificationState,
      detail:
        verificationState === "verified"
          ? "Credential verified and saved."
          : "Saved without verification because the provider could not be reached.",
    };
  }

  async clear(provider: DesktopProvider): Promise<void> {
    await this.#vault.delete(vaultKey(provider));
    await this.#settings.update((current) => {
      const providers = { ...current.providers };
      delete providers[provider];
      return { ...current, providers };
    });
    await this.#onChanged(provider);
  }

  async environment(): Promise<{
    YOUTUBE_API_KEY?: string;
    GITHUB_TOKEN?: string;
  }> {
    const youtubeApiKey = await this.#vault.get("provider:youtube");
    const githubToken = await this.#vault.get("provider:github");
    return {
      ...(youtubeApiKey ? { YOUTUBE_API_KEY: youtubeApiKey } : {}),
      ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
    };
  }

  async #validate(
    input: ProviderCredentialInput,
  ): Promise<"verified" | "unverified"> {
    const request =
      input.provider === "youtube"
        ? new Request(
            `https://www.googleapis.com/youtube/v3/i18nLanguages?part=snippet&key=${encodeURIComponent(input.credential)}`,
            { method: "GET" },
          )
        : new Request("https://api.github.com/user", {
            method: "GET",
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${input.credential}`,
              "user-agent": "Hardware-Desktop",
              "x-github-api-version": "2022-11-28",
            },
          });
    try {
      const response = await this.#fetch(request, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (response.ok) return "verified";
      if ([400, 401, 403].includes(response.status)) {
        throw new ProviderAuthenticationError(input.provider);
      }
      return "unverified";
    } catch (error) {
      if (error instanceof ProviderAuthenticationError) throw error;
      return "unverified";
    }
  }
}

function vaultKey(provider: DesktopProvider): string {
  return `provider:${provider}`;
}
