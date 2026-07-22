const MAX_IMPORT_URL_LENGTH = 2_048;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const SECRET_LIKE_QUERY_PARAMETER =
  /(?:^|[_-])(?:api[_-]?key|auth|authorization|credential|password|secret|signature|token)(?:$|[_-])/iu;

export function hasSecretLikeQueryParameter(url: URL): boolean {
  return [...url.searchParams.keys()].some((name) =>
    SECRET_LIKE_QUERY_PARAMETER.test(name),
  );
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }

  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function isNonPublicIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(hostname: string): number[] | null {
  let host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":") || host.includes("%")) {
    return null;
  }

  const dottedSuffix = host.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedSuffix) {
    const octets = parseIpv4(dottedSuffix);
    if (!octets) return null;
    host = `${host.slice(0, -dottedSuffix.length)}${(
      (octets[0] << 8) |
      octets[1]
    ).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (value: string): number[] | null => {
    if (value === "") return [];
    const parts = value.split(":");
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array<number>(omitted).fill(0), ...right];
}

function isNonPublicIpv6(hostname: string): boolean {
  const parts = parseIpv6(hostname);
  if (!parts) return false;

  const [first, second] = parts;
  const allZeroPrefix = parts.slice(0, 6).every((part) => part === 0);

  return (
    // Only currently allocated global-unicast space is accepted for URL literals.
    (first & 0xe000) !== 0x2000 ||
    // Documentation, Teredo/ORCHID-like tunnels, and 6to4 can conceal targets.
    (first === 0x2001 && (second === 0 || second === 0x0db8)) ||
    first === 0x2002 ||
    // IPv4-compatible and IPv4-mapped forms, including hex-normalized literals.
    allZeroPrefix
  );
}

export function isSafeImportUrlSyntax(value: string): boolean {
  if (value.length > MAX_IMPORT_URL_LENGTH) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    hasSecretLikeQueryParameter(url)
  ) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return false;
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4 && isNonPublicIpv4(ipv4)) {
    return false;
  }

  if (isNonPublicIpv6(hostname)) {
    return false;
  }

  // A public hostname is either an IP literal or has a registrable-looking suffix.
  return ipv4 !== null || hostname.includes(".") || hostname.includes(":");
}

export function isYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return (
      hostname === "youtube.com" ||
      hostname === "m.youtube.com" ||
      hostname === "youtu.be" ||
      hostname === "youtube-nocookie.com"
    );
  } catch {
    return false;
  }
}

export function getYouTubeVideoId(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  let candidate: string | null = null;

  if (hostname === "youtu.be") {
    candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (hostname === "youtube.com" || hostname === "m.youtube.com") {
    if (url.pathname === "/watch") {
      candidate = url.searchParams.get("v");
    } else {
      const [kind, id] = url.pathname.split("/").filter(Boolean);
      if (kind === "shorts" || kind === "embed" || kind === "live") {
        candidate = id ?? null;
      }
    }
  } else if (hostname === "youtube-nocookie.com") {
    const [kind, id] = url.pathname.split("/").filter(Boolean);
    if (kind === "embed") {
      candidate = id ?? null;
    }
  }

  return candidate && YOUTUBE_VIDEO_ID.test(candidate) ? candidate : null;
}

export interface GitHubRepositoryIdentity {
  owner: string;
  repository: string;
}

export function getGitHubRepositoryIdentity(
  value: string,
): GitHubRepositoryIdentity | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }

  if (url.hostname.toLowerCase() !== "github.com") {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    return null;
  }

  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, "");
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPOSITORY.test(repository)) {
    return null;
  }

  return { owner, repository };
}
