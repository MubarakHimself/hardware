import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const VAULT_AAD_PREFIX = "hardware-credential-vault-v1:";
const KEY_CHECK_TEXT = "hardware-vault-key-check";

const encryptedValueSchema = z.object({
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

const vaultFileSchema = z.discriminatedUnion("mode", [
  z.object({
    formatVersion: z.literal(1),
    mode: z.literal("safe-storage"),
    entries: z.record(z.string(), z.string()),
  }),
  z.object({
    formatVersion: z.literal(1),
    mode: z.literal("passphrase"),
    kdf: z.object({
      algorithm: z.literal("scrypt"),
      salt: z.string(),
      cost: z.literal(32768),
      blockSize: z.literal(8),
      parallelization: z.literal(1),
    }),
    keyCheck: encryptedValueSchema,
    entries: z.record(z.string(), encryptedValueSchema),
  }),
]);

type VaultFile = z.infer<typeof vaultFileSchema>;
type PassphraseVault = Extract<VaultFile, { mode: "passphrase" }>;

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface CredentialVaultOptions {
  file: string;
  platform?: NodeJS.Platform;
  safeStorage: SafeStorageAdapter;
}

export class VaultLockedError extends Error {
  constructor(
    message = "Unlock the local credential vault to continue.",
  ) {
    super(message);
    this.name = "VaultLockedError";
  }
}

export class CredentialVault {
  readonly #file: string;
  readonly #platform: NodeJS.Platform;
  readonly #safeStorage: SafeStorageAdapter;
  #contents?: VaultFile;
  #sessionKey?: Buffer;
  #writeChain = Promise.resolve();

  constructor(options: CredentialVaultOptions) {
    this.#file = options.file;
    this.#platform = options.platform ?? process.platform;
    this.#safeStorage = options.safeStorage;
  }

  get mode(): "safe-storage" | "passphrase" {
    // A loaded vault's mode is authoritative. Changing key-store availability
    // must never silently reinterpret or replace encrypted entries.
    return (
      this.#contents?.mode ??
      (this.#requiresPassphrase() ? "passphrase" : "safe-storage")
    );
  }

  get locked(): boolean {
    return this.mode === "passphrase" && !this.#sessionKey;
  }

  async load(): Promise<void> {
    try {
      this.#contents = vaultFileSchema.parse(
        JSON.parse(await readFile(this.#file, "utf8")),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        this.#contents = undefined;
        return;
      }
      throw new Error("The credential vault is damaged or unreadable.", {
        cause: error,
      });
    }

    if (
      this.#contents.mode === "safe-storage" &&
      this.#requiresPassphrase()
    ) {
      throw new VaultLockedError(
        "The operating system key store is unavailable. Restore it before opening this vault.",
      );
    }
    // Passphrase vaults remain passphrase vaults until an explicit, separately
    // verified migration is implemented.
    if (this.#contents.mode === "passphrase") this.#sessionKey = undefined;
  }

  async unlock(passphrase: string): Promise<void> {
    if (this.mode !== "passphrase") return;
    const existing =
      this.#contents?.mode === "passphrase" ? this.#contents : undefined;
    const salt = existing
      ? Buffer.from(existing.kdf.salt, "base64")
      : randomBytes(16);
    const key = await deriveKey(passphrase, salt);

    if (existing) {
      const check = decryptValue(existing.keyCheck, key, "__key_check__");
      const supplied = Buffer.from(check);
      const expected = Buffer.from(KEY_CHECK_TEXT);
      if (
        supplied.byteLength !== expected.byteLength ||
        !timingSafeEqual(supplied, expected)
      ) {
        key.fill(0);
        throw new VaultLockedError("The vault passphrase is incorrect.");
      }
    } else {
      this.#contents = {
        formatVersion: 1,
        mode: "passphrase",
        kdf: {
          algorithm: "scrypt",
          salt: salt.toString("base64"),
          cost: 32768,
          blockSize: 8,
          parallelization: 1,
        },
        keyCheck: encryptValue(KEY_CHECK_TEXT, key, "__key_check__"),
        entries: {},
      };
      await this.#persist();
    }
    this.#sessionKey?.fill(0);
    this.#sessionKey = key;
  }

  lock(): void {
    this.#sessionKey?.fill(0);
    this.#sessionKey = undefined;
  }

  async get(key: string): Promise<string | undefined> {
    const contents = this.#contents;
    if (!contents) return undefined;
    if (contents.mode === "safe-storage") {
      const encrypted = contents.entries[key];
      if (!encrypted) return undefined;
      return this.#safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    }
    const encrypted = contents.entries[key];
    if (!encrypted) return undefined;
    return decryptValue(encrypted, this.#requireSessionKey(), key);
  }

  async set(key: string, value: string): Promise<void> {
    if (!key || key.length > 160) throw new Error("Invalid vault key.");
    if (this.mode === "safe-storage") {
      if (!this.#safeStorage.isEncryptionAvailable()) {
        throw new VaultLockedError(
          "The operating system credential store is unavailable.",
        );
      }
      const entries =
        this.#contents?.mode === "safe-storage"
          ? { ...this.#contents.entries }
          : {};
      entries[key] = this.#safeStorage.encryptString(value).toString("base64");
      this.#contents = {
        formatVersion: 1,
        mode: "safe-storage",
        entries,
      };
    } else {
      const keyBuffer = this.#requireSessionKey();
      const current =
        this.#contents?.mode === "passphrase"
          ? this.#contents
          : await this.#newPassphraseVault(keyBuffer);
      this.#contents = {
        ...current,
        entries: {
          ...current.entries,
          [key]: encryptValue(value, keyBuffer, key),
        },
      };
    }
    await this.#persist();
  }

  async delete(key: string): Promise<void> {
    if (!this.#contents) return;
    const entries = { ...this.#contents.entries };
    delete entries[key];
    this.#contents = { ...this.#contents, entries } as VaultFile;
    await this.#persist();
  }

  async #newPassphraseVault(key: Buffer): Promise<PassphraseVault> {
    const salt = randomBytes(16);
    return {
      formatVersion: 1,
      mode: "passphrase",
      kdf: {
        algorithm: "scrypt",
        salt: salt.toString("base64"),
        cost: 32768,
        blockSize: 8,
        parallelization: 1,
      },
      keyCheck: encryptValue(KEY_CHECK_TEXT, key, "__key_check__"),
      entries: {},
    };
  }

  #requiresPassphrase(): boolean {
    if (this.#platform !== "linux") {
      return !this.#safeStorage.isEncryptionAvailable();
    }
    const backend = this.#safeStorage.getSelectedStorageBackend?.();
    return (
      !this.#safeStorage.isEncryptionAvailable() ||
      backend === "basic_text" ||
      backend === "unknown"
    );
  }

  #requireSessionKey(): Buffer {
    if (!this.#sessionKey) throw new VaultLockedError();
    return this.#sessionKey;
  }

  async #persist(): Promise<void> {
    if (!this.#contents) return;
    const contents = JSON.stringify(this.#contents);
    this.#writeChain = this.#writeChain.then(async () => {
      const directory = path.dirname(this.#file);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.#file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporary, contents, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, this.#file);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    await this.#writeChain;
  }
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      passphrase,
      salt,
      32,
      {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function encryptValue(
  plaintext: string,
  key: Buffer,
  entryName: string,
): z.infer<typeof encryptedValueSchema> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${VAULT_AAD_PREFIX}${entryName}`));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptValue(
  encrypted: z.infer<typeof encryptedValueSchema>,
  key: Buffer,
  entryName: string,
): string {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(encrypted.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(`${VAULT_AAD_PREFIX}${entryName}`));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new VaultLockedError("The vault passphrase is incorrect.");
  }
}
