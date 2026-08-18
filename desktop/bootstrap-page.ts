export function createBootstrapPage(): string {
  const nonce = cryptoRandomNonce();
  const contentSecurityPolicy = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src data:",
    "connect-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hardware</title>
    <style nonce="${nonce}">
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f7f3e8;
        background: radial-gradient(circle at 18% 15%, #3b3021 0, #171713 34%, #0e0e0c 100%); }
      main { width: min(620px, calc(100vw - 48px)); border: 1px solid #514630; border-radius: 22px;
        padding: 34px; background: rgba(23, 23, 19, .94); box-shadow: 0 24px 90px #0009; }
      .mark { width: 58px; height: 58px; display: grid; place-items: center; border-radius: 16px;
        background: #e6a52f; color: #17130b; font-size: 29px; font-weight: 900; letter-spacing: -4px; }
      h1 { margin: 22px 0 8px; font-size: 28px; letter-spacing: -.03em; }
      p { margin: 0; color: #bdb6a6; line-height: 1.55; }
      .status { min-height: 52px; margin: 24px 0 12px; padding: 14px 16px; border-radius: 12px;
        background: #0f0f0d; border: 1px solid #343128; color: #e8dec9; }
      .bar { height: 3px; overflow: hidden; border-radius: 999px; background: #2b2922; margin-bottom: 24px; }
      .bar::after { content: ""; display: block; width: 38%; height: 100%; background: #e6a52f;
        animation: progress 1.3s ease-in-out infinite alternate; }
      @keyframes progress { from { transform: translateX(-70%); } to { transform: translateX(235%); } }
      .actions { display: flex; flex-wrap: wrap; gap: 10px; }
      button { border: 1px solid #4c4638; border-radius: 10px; padding: 10px 14px; color: #efe8d9;
        background: #25231d; font: inherit; cursor: pointer; }
      button:hover { border-color: #e6a52f; }
      button.primary { color: #17130b; background: #e6a52f; border-color: #e6a52f; font-weight: 700; }
      .vault { display: none; margin: 18px 0; gap: 10px; }
      .vault.visible { display: flex; }
      input { min-width: 0; flex: 1; border: 1px solid #4c4638; border-radius: 10px; padding: 10px 12px;
        color: #f7f3e8; background: #0f0f0d; font: inherit; }
      .error { min-height: 20px; margin-top: 12px; color: #e4a18f; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <div class="mark" aria-hidden="true">H</div>
      <h1>Opening Hardware</h1>
      <p>Your library, database, and background jobs stay on this computer.</p>
      <div class="status" id="status" role="status" aria-live="polite">Preparing local services…</div>
      <div class="bar" id="bar"></div>
      <div class="vault" id="vault">
        <input id="passphrase" type="password" minlength="12" autocomplete="current-password"
          placeholder="Vault passphrase" aria-label="Vault passphrase">
        <button class="primary" id="unlock">Unlock</button>
      </div>
      <div class="actions">
        <button class="primary" id="retry">Retry startup</button>
        <button id="restore">Restore backup</button>
        <button id="logs">Open logs</button>
        <button id="quit">Quit</button>
      </div>
      <div class="error" id="error" role="alert"></div>
    </main>
    <script nonce="${nonce}">
      const api = window.hardwareDesktop;
      const status = document.getElementById("status");
      const error = document.getElementById("error");
      const vault = document.getElementById("vault");
      const bar = document.getElementById("bar");
      const showError = (value) => { error.textContent = value instanceof Error ? value.message : String(value); };
      const render = (value) => {
        status.textContent = value.detail;
        vault.classList.toggle("visible", value.phase === "recovery" && /vault|passphrase|unlock/i.test(value.detail));
        bar.hidden = value.phase === "recovery" || value.phase === "idle";
      };
      if (!api) showError("The native Hardware bridge is unavailable.");
      else {
        api.getRuntimeStatus().then(render).catch(showError);
        api.onRuntimeStatus(render);
        document.getElementById("retry").addEventListener("click", () => api.retryStartup().catch(showError));
        document.getElementById("restore").addEventListener("click", () => api.restoreBackup().catch(showError));
        document.getElementById("logs").addEventListener("click", () => api.openLogsFolder().catch(showError));
        document.getElementById("quit").addEventListener("click", () => api.quit().catch(showError));
        document.getElementById("unlock").addEventListener("click", () => {
          const input = document.getElementById("passphrase");
          api.unlockCredentialVault(input.value).then(() => {
            input.value = "";
            return api.retryStartup();
          }).catch(showError);
        });
      }
    </script>
  </body>
</html>`;
}

function cryptoRandomNonce(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

