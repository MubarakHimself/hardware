import { describe, expect, it, vi } from "vitest";
import {
  extractWebsiteMetadata,
  fetchWebsiteMetadata,
  sanitizeMetadataText,
  type DnsResolver,
  type SafeFetchImplementation,
} from "../../lib/ingestion";

const publicDns: DnsResolver = async () => [
  { address: "93.184.216.34", family: 4 },
];

describe("website metadata extraction", () => {
  it("extracts and sanitizes deterministic document and Open Graph fields", () => {
    const html = `<!doctype html>
      <html>
        <head>
          <title> Acme &amp; <b>Tool</b> </title>
          <meta name="description" content=" Build &amp; ship   faster. ">
          <meta property="og:title" content="Acme OG">
          <meta property="og:description" content="OG &lt;description&gt;">
          <meta property="og:image" content="/images/card.png#fragment">
          <meta property="og:url" content="/product#section">
          <meta property="og:site_name" content="Acme Site">
          <meta property="og:type" content="website">
          <link rel="canonical" href="/canonical#fragment">
          <link rel="apple-touch-icon" href="/apple.png">
          <link rel="shortcut icon" href="/favicon.ico">
        </head>
        <body>
          <a href="https://github.com/Acme/Tool">Source</a>
          <a href="https://github.com/acme/tool/issues">Issues duplicate</a>
          <a href="https://github.com/topics/ai">Not a repository</a>
          <script><a href="https://github.com/evil/fake">fake</a></script>
        </body>
      </html>`;

    expect(
      extractWebsiteMetadata(html, "https://project.example/docs/page"),
    ).toEqual({
      title: "Acme & Tool",
      description: "Build & ship faster.",
      canonicalUrl: "https://project.example/canonical",
      iconUrl: "https://project.example/favicon.ico",
      openGraph: {
        title: "Acme OG",
        description: "OG <description>",
        imageUrl: "https://project.example/images/card.png",
        url: "https://project.example/product",
        siteName: "Acme Site",
        type: "website",
      },
      githubRepositories: [
        { repoKey: "acme/tool", url: "https://github.com/acme/tool" },
      ],
    });
  });

  it("uses safe base resolution and Open Graph fallbacks", () => {
    const html = `
      <base href="https://assets.example/base/">
      <meta property="og:title" content="Fallback title">
      <meta property="og:description" content="Fallback description">
      <meta property="og:image:secure_url" content="secure.png">
      <link rel="canonical" href="project">
      <link rel="icon" href="icon.svg">
    `;

    expect(extractWebsiteMetadata(html, "https://project.example/page")).toEqual({
      title: "Fallback title",
      description: "Fallback description",
      canonicalUrl: "https://assets.example/base/project",
      iconUrl: "https://assets.example/base/icon.svg",
      openGraph: {
        title: "Fallback title",
        description: "Fallback description",
        imageUrl: "https://assets.example/base/secure.png",
      },
      githubRepositories: [],
    });
  });

  it("ignores unsafe URL schemes, credentials, comments, and raw script content", () => {
    const html = `
      <!-- <link rel="canonical" href="https://evil.example"> -->
      <title>Safe</title>
      <link rel="canonical" href="javascript:alert(1)">
      <link rel="icon" href="https://user:pass@example.com/icon.png">
      <meta property="og:image" content="data:image/png;base64,AAAA">
      <meta property="og:url" content="https://example.com/?access_token=secret">
      <a href="javascript:alert(1)">bad</a>
      <style><a href="https://github.com/evil/style">fake</a></style>
    `;

    expect(extractWebsiteMetadata(html, "https://project.example")).toEqual({
      title: "Safe",
      description: undefined,
      canonicalUrl: undefined,
      iconUrl: undefined,
      openGraph: {},
      githubRepositories: [],
    });
  });

  it("normalizes plain text, entities, controls, and limits", () => {
    expect(
      sanitizeMetadataText("  A&nbsp;  B\u0000 &amp; C  ", 100),
    ).toBe("A B & C");
    expect(sanitizeMetadataText("abcdefgh", 4)).toBe("abcd");
    expect(sanitizeMetadataText("   ", 10)).toBeUndefined();
  });
});

describe("fetchWebsiteMetadata", () => {
  it("combines the safe injected fetch with deterministic extraction", async () => {
    const resolver = vi.fn<DnsResolver>(publicDns);
    const transport = vi.fn<SafeFetchImplementation>(async () =>
      new Response(
        `<title>Fetched</title>
         <meta name="description" content="No network used">
         <a href="https://github.com/Acme/Fetched">GitHub</a>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    );

    const metadata = await fetchWebsiteMetadata("https://project.example", {
      fetch: transport,
      resolveDns: resolver,
    });

    expect(metadata).toEqual({
      requestedUrl: "https://project.example",
      finalUrl: "https://project.example/",
      status: 200,
      contentType: "text/html",
      redirectCount: 0,
      title: "Fetched",
      description: "No network used",
      canonicalUrl: undefined,
      iconUrl: undefined,
      openGraph: {},
      githubRepositories: [
        { repoKey: "acme/fetched", url: "https://github.com/acme/fetched" },
      ],
    });
    expect(resolver).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });
});
