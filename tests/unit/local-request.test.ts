import { describe, expect, it } from "vitest";
import {
  isAllowedLocalHost,
  isAllowedLocalOrigin,
} from "../../lib/server/local-request";

describe("local browser request boundary", () => {
  const configured = "http://127.0.0.1:3000";

  it("accepts standard loopback aliases only on the configured port", () => {
    expect(isAllowedLocalHost("localhost:3000", configured)).toBe(true);
    expect(isAllowedLocalHost("[::1]:3000", configured)).toBe(true);
    expect(isAllowedLocalHost("127.0.0.1:3001", configured)).toBe(false);
    expect(isAllowedLocalHost("app.example:3000", configured)).toBe(false);
  });

  it("requires a syntactically exact loopback Origin for mutations", () => {
    expect(isAllowedLocalOrigin("http://127.0.0.1:3000", configured)).toBe(true);
    expect(isAllowedLocalOrigin("http://localhost:3000", configured)).toBe(true);
    expect(isAllowedLocalOrigin("http://127.0.0.1:3000/path", configured)).toBe(false);
    expect(isAllowedLocalOrigin("https://127.0.0.1:3000", configured)).toBe(false);
    expect(isAllowedLocalOrigin("http://evil.example:3000", configured)).toBe(false);
    expect(isAllowedLocalOrigin(null, configured)).toBe(false);
  });
});
