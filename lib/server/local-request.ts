const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

/** Rejects DNS-rebinding Host headers while allowing standard loopback aliases. */
export function isAllowedLocalHost(
  hostHeader: string | null,
  configuredOrigin: string,
): boolean {
  if (!hostHeader) return false;
  try {
    const configured = new URL(configuredOrigin);
    const candidate = new URL(`http://${hostHeader}`);
    return (
      isLoopback(configured) &&
      isLoopback(candidate) &&
      !candidate.username &&
      !candidate.password &&
      candidate.pathname === "/" &&
      effectivePort(candidate) === effectivePort(configured)
    );
  } catch {
    return false;
  }
}

/** Browser mutations must originate from a loopback alias on the configured port. */
export function isAllowedLocalOrigin(
  originHeader: string | null,
  configuredOrigin: string,
): boolean {
  if (!originHeader) return false;
  const supplied = originHeader.trim();
  try {
    const configured = new URL(configuredOrigin);
    const candidate = new URL(supplied);
    return (
      supplied === candidate.origin &&
      candidate.protocol === "http:" &&
      isLoopback(configured) &&
      isLoopback(candidate) &&
      !candidate.username &&
      !candidate.password &&
      effectivePort(candidate) === effectivePort(configured)
    );
  } catch {
    return false;
  }
}
