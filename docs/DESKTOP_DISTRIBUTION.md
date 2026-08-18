# Hardware Desktop Alpha distribution

Hardware Desktop packages the existing Next.js application, Graphile Worker,
database migrator, and PostgreSQL 17.10 into one application-owned Electron
installation. The desktop release does not require Docker, Node.js, Git,
PowerShell, or a separately installed PostgreSQL server.

The current package version is `0.2.0-alpha.1`. It is an unsigned personal
alpha for Windows 11 x64. Ubuntu 24.04 x64 is enabled for
`0.2.0-alpha.2` after Windows acceptance.

## Runtime payload

`npm run desktop:prepare` creates two generated trees:

```text
build/
  desktop/
    main.js
    preload.cjs
    utility-host.js
    package.json
  runtime/
    server.js
    node_modules/
    public/
    .next/
    dist-worker/
    dist-db/
    drizzle/
```

The generated desktop `package.json` has no dependency graph because tsup
bundles the native-process code; this prevents the web application’s production
`node_modules` from being duplicated inside `app.asar`.

`vendor/postgres/<platform>-x64` is copied beside that runtime as an
electron-builder `extraResource`. It remains outside `app.asar`, because
PostgreSQL executables, libraries, extension SQL, and timezone/catalog data
must be normal files. Hardware starts this PostgreSQL child process itself and
never registers a Windows service or systemd unit.

The application source is kept in `app.asar`. Packaging flips Electron fuses to
disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, and CLI inspection, enables
cookie encryption, and restricts the app to its ASAR. Embedded ASAR-integrity
validation is enabled on Windows; Electron does not provide the same embedded
integrity mechanism for Linux packages.

## Local Windows build

Use Node 24 and npm 11 on a Windows x64 development machine:

```powershell
npm install
npm run desktop:check
npm run postgres:acquire:win
npm run desktop:package:win
npm run release:metadata -- --platform windows
```

The PostgreSQL acquisition step verifies the official 17.10 binary archive
against both its pinned length and SHA-256 before extraction. A bad cached
archive fails closed. Generated packages are written to `release/desktop/`:

- `Hardware-0.2.0-alpha.1-win-x64-setup.exe`
- `Hardware-0.2.0-alpha.1-win-x64.zip`
- Windows CycloneDX SBOM and SHA-256 manifest
- PostgreSQL provenance lock and third-party notices

The NSIS installer is per-user, does not request elevation, creates desktop and
Start-menu shortcuts, and preserves `%LOCALAPPDATA%\Hardware` during uninstall
or reinstall. The ZIP uses the same profile data; it is a no-install package,
not a database stored beside the executable.

Use `npm run desktop:package:dir` for an unpacked application. It still requires
the matching verified PostgreSQL tree, making it suitable for packaged-runtime
smoke tests rather than a web-only development shortcut.

## Ubuntu 24.04 build

Build on an Ubuntu 24.04 amd64 host:

```bash
sudo apt-get update
sudo apt-get install build-essential bzip2 ca-certificates curl patchelf zlib1g-dev
npm ci
npm run postgres:acquire:linux
npm run desktop:package:linux
npm run release:metadata -- --platform linux
```

The Linux acquisition command compiles the checksum-pinned official 17.10
source archive with a constrained feature set and installs `pg_trgm`. It
rejects unexpected dynamic-library dependencies. Outputs are:

- `hardware_0.2.0-alpha.2_amd64.deb` after the package version is advanced;
- `Hardware-0.2.0-alpha.2-x86_64.AppImage`;
- Linux CycloneDX SBOM, SHA-256 manifest, provenance, and notices.

Install the Debian package with:

```bash
sudo apt install ./hardware_0.2.0-alpha.2_amd64.deb
```

Package removal preserves XDG Hardware data and external backups. The AppImage
may require the Ubuntu FUSE 2 compatibility package; when FUSE mounting is
unavailable it can be tested with `--appimage-extract-and-run`.

## CI and prereleases

`.github/workflows/desktop-release.yml` builds Windows artifacts for the
`v0.2.0-alpha.1` tag. Later alpha tags build Windows and Ubuntu artifacts. A
manual dispatch can build Windows, Linux, or both without publishing a GitHub
release. A pushed tag must exactly equal `v` plus the `package.json` version.

Tag builds publish a GitHub prerelease only after all required platform jobs
succeed. Releases remain intentionally unsigned, contain no automatic updater,
and include checksums, platform SBOMs, PostgreSQL provenance, and notices.

Before a tag is pushed, verify a clean machine can launch with no provider
keys, exercise ingestion after adding a YouTube key, complete backup/restore,
fully stop all child processes on quit, and retain the library across
installer/ZIP replacement.
