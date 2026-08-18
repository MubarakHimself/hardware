import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  Session,
  WebContents,
} from "electron";
import { isIP } from "node:net";
import { BOOTSTRAP_URL, TRUSTED_BOOTSTRAP_ORIGIN } from "./channels";
import type { DesktopLogger } from "./logger";
import { silentLogger } from "./logger";

export interface SessionSecurityOptions {
  session: Session;
  sessionToken: string;
  getApplicationOrigin: () => string | undefined;
  openExternal: (url: string) => Promise<void>;
  logger?: DesktopLogger;
}

export function installSessionSecurity(
  options: SessionSecurityOptions,
): void {
  const logger = options.logger ?? silentLogger;
  options.session.setPermissionCheckHandler(() => false);
  options.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  options.session.setDevicePermissionHandler(() => false);
  options.session.on("will-download", (event) => event.preventDefault());

  options.session.webRequest.onBeforeSendHeaders(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      const applicationOrigin = options.getApplicationOrigin();
      const headers = { ...details.requestHeaders };
      let requestOrigin: string | undefined;
      try {
        requestOrigin = new URL(details.url).origin;
      } catch {
        requestOrigin = undefined;
      }
      if (applicationOrigin && requestOrigin === applicationOrigin) {
        headers.Authorization = `Bearer ${options.sessionToken}`;
      } else {
        deleteHeader(headers, "authorization");
      }
      callback({ requestHeaders: headers });
    },
  );

  options.session.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      const applicationOrigin = options.getApplicationOrigin();
      if (isTrustedRendererRequest(details.url, applicationOrigin)) {
        callback({});
        return;
      }
      logger.warn({
        event: "renderer_request_blocked",
        resourceType: details.resourceType,
      });
      callback({ cancel: true });
    },
  );
}

export function secureBrowserWindow(
  window: BrowserWindow,
  options: {
    getApplicationOrigin: () => string | undefined;
    openExternal: (url: string) => Promise<void>;
    logger?: DesktopLogger;
  },
): void {
  const logger = options.logger ?? silentLogger;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void options.openExternal(url).catch(() => undefined);
    } else {
      logger.warn({ event: "popup_blocked" });
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedTopLevelUrl(url, options.getApplicationOrigin())) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void options.openExternal(url).catch(() => undefined);
    } else {
      logger.warn({ event: "navigation_blocked" });
    }
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    logger.warn({ event: "webview_blocked" });
  });
}

export function verifyIpcSender(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  applicationOrigin: string | undefined,
): void {
  if (
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("Untrusted IPC sender.");
  }
  const senderUrl = event.senderFrame.url;
  if (!isTrustedTopLevelUrl(senderUrl, applicationOrigin)) {
    throw new Error("Untrusted IPC origin.");
  }
}

export function isTrustedTopLevelUrl(
  value: string,
  applicationOrigin: string | undefined,
): boolean {
  if (value === BOOTSTRAP_URL || value.startsWith(`${BOOTSTRAP_URL}?`)) {
    return true;
  }
  try {
    return Boolean(
      applicationOrigin && new URL(value).origin === applicationOrigin,
    );
  } catch {
    return false;
  }
}

export function isTrustedRendererRequest(
  value: string,
  applicationOrigin: string | undefined,
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "data:" && value.startsWith("data:image/")) return true;
    if (url.protocol === "blob:" && applicationOrigin) {
      return url.origin === applicationOrigin;
    }
    if (
      url.protocol === "hardware:" &&
      url.origin === TRUSTED_BOOTSTRAP_ORIGIN
    ) {
      return true;
    }
    return Boolean(applicationOrigin && url.origin === applicationOrigin);
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return false;
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "0.0.0.0" ||
      hostname === "::1"
    ) {
      return false;
    }
    if (isIP(hostname) === 4) {
      const octets = hostname.split(".").map(Number);
      if (
        octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)
      ) {
        return false;
      }
    }
    if (isIP(hostname) === 6) {
      if (
        hostname === "::1" ||
        hostname.startsWith("fe80:") ||
        hostname.startsWith("fc") ||
        hostname.startsWith("fd")
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function deleteHeader(
  headers: Record<string, string | string[]>,
  target: string,
): void {
  const matched = Object.keys(headers).find(
    (key) => key.toLowerCase() === target,
  );
  if (matched) delete headers[matched];
}

export function webContentsAlive(
  webContents: WebContents | undefined,
): webContents is WebContents {
  return Boolean(webContents && !webContents.isDestroyed());
}

