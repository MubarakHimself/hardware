import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialVault,
  VaultLockedError,
  type SafeStorageAdapter,
} from "../../desktop/vault";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function fakeSafeStorage(state: {
  available: boolean;
  backend: string;
}): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => state.backend,
    encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) =>
      value.toString("utf8").replace(/^protected:/, ""),
  };
}

async function vaultFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "hardware-vault-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "credentials.vault");
}

describe("desktop credential vault", () => {
  it("round-trips credentials through operating-system safe storage", async () => {
    const file = await vaultFile();
    const vault = new CredentialVault({
      file,
      platform: "win32",
      safeStorage: fakeSafeStorage({
        available: true,
        backend: "dpapi",
      }),
    });
    await vault.load();
    await vault.set("provider:youtube", "a-secret-value");

    expect(await vault.get("provider:youtube")).toBe("a-secret-value");
  });

  it("rejects Linux basic_text until a session passphrase unlocks it", async () => {
    const file = await vaultFile();
    const vault = new CredentialVault({
      file,
      platform: "linux",
      safeStorage: fakeSafeStorage({
        available: true,
        backend: "basic_text",
      }),
    });
    await vault.load();

    expect(vault.locked).toBe(true);
    await expect(vault.set("provider:github", "token")).rejects.toBeInstanceOf(
      VaultLockedError,
    );
    await vault.unlock("a sufficiently long passphrase");
    await vault.set("provider:github", "token");
    vault.lock();
    await expect(vault.get("provider:github")).rejects.toBeInstanceOf(
      VaultLockedError,
    );
  });

  it("keeps a loaded passphrase vault authoritative if safe storage returns", async () => {
    const file = await vaultFile();
    const state = { available: false, backend: "unknown" };
    const first = new CredentialVault({
      file,
      platform: "win32",
      safeStorage: fakeSafeStorage(state),
    });
    await first.load();
    await first.unlock("a durable local passphrase");
    await first.set("provider:youtube", "preserve-this-secret");
    first.lock();

    state.available = true;
    state.backend = "dpapi";
    const reopened = new CredentialVault({
      file,
      platform: "win32",
      safeStorage: fakeSafeStorage(state),
    });
    await reopened.load();

    expect(reopened.mode).toBe("passphrase");
    expect(reopened.locked).toBe(true);
    await reopened.unlock("a durable local passphrase");
    expect(await reopened.get("provider:youtube")).toBe(
      "preserve-this-secret",
    );
  });
});

