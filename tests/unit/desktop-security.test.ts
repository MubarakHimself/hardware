import { describe, expect, it } from "vitest";
import {
  isSafeExternalUrl,
  isTrustedRendererRequest,
  isTrustedTopLevelUrl,
} from "../../desktop/security";

describe("Electron renderer boundary", () => {
  it("allows only the exact dynamic application origin and native bootstrap", () => {
    const origin = "http://127.0.0.1:45123";
    expect(isTrustedTopLevelUrl(`${origin}/projects`, origin)).toBe(true);
    expect(isTrustedTopLevelUrl("hardware://bootstrap/", origin)).toBe(true);
    expect(
      isTrustedTopLevelUrl("http://127.0.0.1:45124/projects", origin),
    ).toBe(false);
    expect(
      isTrustedRendererRequest(`${origin}/_next/static/app.js`, origin),
    ).toBe(true);
    expect(
      isTrustedRendererRequest("https://example.com/tracker.js", origin),
    ).toBe(false);
  });

  it("opens public links externally but rejects local and privileged URLs", () => {
    expect(isSafeExternalUrl("https://github.com/example/project")).toBe(true);
    expect(isSafeExternalUrl("http://example.com/docs")).toBe(true);
    expect(isSafeExternalUrl("http://127.0.0.1:3000/private")).toBe(false);
    expect(isSafeExternalUrl("http://192.168.1.1/admin")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
  });
});

