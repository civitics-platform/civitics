# `scripts/pg_repack/` — the pinned pg_repack client (FIX-1258)

The client must match the server's extension version exactly. Read it live:
`SELECT default_version FROM pg_available_extensions WHERE name = 'pg_repack'`
(1.5.2 on prod, 2026-10-23). Then build with that version:

```bash
docker build --build-arg PG_REPACK_VERSION=1.5.2 -t civitics/pg_repack:1.5.2 scripts/pg_repack
docker run --rm civitics/pg_repack:1.5.2 pg_repack --version   # must print: pg_repack 1.5.2
```

The build takes one of two paths, and the build log names it. Path 1 is the PGDG
apt package, when `apt-cache madison` still lists that exact version. Path 2 is a
source build of the `reorg/pg_repack` tag `ver_<version>`. In 2026-10, PGDG lists
only 1.5.3, so 1.5.2 builds by path 2. The image is about 625 MB.

`scripts/fix1258-repack-entity-tags.mjs` runs the image. It passes the password
as `-e PGPASSWORD` by name, never in argv.
