# Hardware desktop third-party notices

Hardware is distributed as a personal unsigned alpha. This summary accompanies
the machine-readable CycloneDX SBOM generated for every packaged platform. It
does not replace the license texts embedded by upstream projects.

## Electron

Hardware Desktop uses Electron 43.2.0, which incorporates Chromium and Node.js.
Electron is licensed under the MIT License. Chromium, Node.js, and their
dependencies retain their respective upstream licenses and notices inside the
Electron distribution.

- <https://github.com/electron/electron>
- <https://www.electronjs.org/licenses>

## PostgreSQL

Hardware bundles PostgreSQL 17.10 as an application-managed runtime.
PostgreSQL is released under the PostgreSQL License. The packaged runtime
includes its upstream server license and applicable command-line-tool notices.
The exact upstream inputs, byte lengths, SHA-256 digests, and included runtime
trees are recorded in `postgres-provenance.lock.json`.

- <https://www.postgresql.org/about/licence/>
- <https://www.postgresql.org/ftp/source/v17.10/>
- <https://www.enterprisedb.com/download-postgresql-binaries>

## JavaScript dependencies

The release SBOM lists the JavaScript dependency graph and declared licenses.
License files included by electron-builder and the Next.js standalone trace
remain part of the packaged application. No dependency notice grants rights to
Hardware’s own application source.
