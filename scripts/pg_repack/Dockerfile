# FIX-1258 — a pg_repack CLIENT pinned to prod's extension version (cc-244, D1).
#
# The pg_repack client refuses to run against a server-side extension of a
# different version ("program 'pg_repack 1.5.x' does not match database library
# ..."), so the version is a build ARG that follows prod's live
# pg_available_extensions.default_version — never a guess:
#
#   docker build --build-arg PG_REPACK_VERSION=1.5.2 -t civitics/pg_repack:1.5.2 scripts/pg_repack
#   docker run --rm civitics/pg_repack:1.5.2 pg_repack --version
#
# Two install paths behind the one ARG:
#   1. the PGDG apt repo the official postgres image already carries, when it
#      still lists exactly <version> (apt-cache madison is printed either way);
#   2. otherwise a source build of the reorg/pg_repack tag ver_<version>.
# The server is aarch64; this client's architecture is irrelevant — only the
# extension version has to match.

ARG PG_MAJOR=17
FROM postgres:${PG_MAJOR}-bookworm

ARG PG_MAJOR=17
ARG PG_REPACK_VERSION

RUN set -eux; \
    test -n "${PG_REPACK_VERSION}" || { echo "PG_REPACK_VERSION build-arg is required"; exit 1; }; \
    apt-get update; \
    echo "--- apt-cache madison postgresql-${PG_MAJOR}-repack ---"; \
    apt-cache madison "postgresql-${PG_MAJOR}-repack" || true; \
    exact="$(apt-cache madison "postgresql-${PG_MAJOR}-repack" | awk -F'|' '{gsub(/ /,"",$2); print $2}' | grep "^${PG_REPACK_VERSION}-" | head -n1 || true)"; \
    if [ -n "${exact}" ]; then \
      echo "--- path 1: PGDG apt ${exact} ---"; \
      apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}-repack=${exact}"; \
    else \
      echo "--- path 2: ${PG_REPACK_VERSION} not in the live repo; source build of ver_${PG_REPACK_VERSION} ---"; \
      build_deps="git build-essential postgresql-server-dev-${PG_MAJOR} libreadline-dev zlib1g-dev \
        liblz4-dev libzstd-dev libssl-dev libkrb5-dev libselinux1-dev libxslt1-dev libpam0g-dev"; \
      apt-get install -y --no-install-recommends ca-certificates ${build_deps}; \
      git clone --depth 1 --branch "ver_${PG_REPACK_VERSION}" https://github.com/reorg/pg_repack /tmp/pg_repack; \
      make -C /tmp/pg_repack; \
      make -C /tmp/pg_repack install; \
      rm -rf /tmp/pg_repack; \
      apt-get purge -y --auto-remove ${build_deps}; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    pg_repack --version

# The client only — never start a server in this image.
ENTRYPOINT []
CMD ["pg_repack", "--version"]
