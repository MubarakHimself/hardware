/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const {
  flipFuses,
  FuseVersion,
  FuseV1Options,
} = require("@electron/fuses");

module.exports = async function enableWindowsAsarIntegrity(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const executablePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  });
};
