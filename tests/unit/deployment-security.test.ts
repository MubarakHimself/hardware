import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const caddy = readFileSync(
  new URL("../../deploy/Caddyfile", import.meta.url),
  "utf8",
);
const deploy = readFileSync(
  new URL("../../deploy/deploy.sh", import.meta.url),
  "utf8",
);
const exampleEnvironment = readFileSync(
  new URL("../../.env.example", import.meta.url),
  "utf8",
);

describe("deployment credential boundaries", () => {
  it("uses bearer auth for readiness and redacts probe credentials from access logs", () => {
    expect(deploy).toContain(
      "authorization:'Bearer '+process.env.HEALTHCHECK_TOKEN",
    );
    expect(deploy.toLowerCase()).not.toContain("x-healthcheck-token");
    expect(caddy).toContain("request>headers>Authorization delete");
    expect(caddy).toContain("request>headers>X-Healthcheck-Token delete");
  });

  it("does not ship a usable default healthcheck credential", () => {
    expect(exampleEnvironment).toMatch(/^HEALTHCHECK_TOKEN=$/m);
    expect(exampleEnvironment).not.toContain(
      "HEALTHCHECK_TOKEN=replace_with_a_long_random_value",
    );
  });

  it("derives an immutable production release from a Git commit", () => {
    expect(exampleEnvironment).toMatch(/^RELEASE_SHA=$/m);
    expect(exampleEnvironment).not.toContain("RELEASE_SHA=development");
    expect(deploy).toContain(
      'git rev-parse --verify "${RELEASE_SHA}^{commit}"',
    );
    expect(deploy).toContain("git rev-parse --verify HEAD");
  });
});
