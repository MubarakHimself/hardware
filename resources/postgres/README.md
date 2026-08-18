# PostgreSQL desktop runtime

Hardware packages PostgreSQL 17.10 as an application-owned child process. It
does not install or control a Windows service or a systemd unit.

`provenance.lock.json` pins every upstream input by URL, byte length, and
SHA-256. Generated runtimes live under `vendor/postgres/` and are deliberately
ignored by Git:

```text
vendor/postgres/
  win32-x64/
    bin/
    lib/
    share/
  linux-x64/
    bin/
    lib/
    share/
```

Acquire the Windows runtime with:

```powershell
npm run postgres:acquire:win
```

The downloader caches the exact archive under `.desktop-cache/`, verifies its
length and digest before extraction, extracts only the server/runtime trees and
license notices, then verifies the required executables and `pg_trgm` files.
An existing cache entry with the wrong digest is rejected rather than replaced.
Pass a separately obtained archive explicitly when necessary:

```powershell
npm run postgres:acquire:win -- --archive C:\Downloads\postgresql-17.10-1-windows-x64-binaries.zip
```

Build the Ubuntu 24.04 x64 runtime from the pinned official source archive on an
Ubuntu host with:

```bash
sudo apt-get install build-essential curl ca-certificates bzip2 patchelf zlib1g-dev
npm run postgres:acquire:linux
```

That build deliberately disables optional server integrations Hardware does
not use, installs `pg_trgm`, sets a relative runtime library path, strips build
artifacts, and rejects unexpected shared-library dependencies. The resulting
runtime is app-managed even when delivered by the Hardware `.deb`.

When PostgreSQL changes, update the version, URL, byte length, digest, build
recipe, notices, recovery tests, and both packaged-platform smoke tests in one
reviewed change.
