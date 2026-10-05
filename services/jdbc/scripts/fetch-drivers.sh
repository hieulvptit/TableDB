#!/usr/bin/env bash
# Downloads the vetted JDBC drivers from Maven Central into a drivers/ directory and writes manifest.json
# ({"drivers":[{type,file,sha256,version,class}]}) with SHA-256 computed from the downloaded bytes.
# The download is cross-checked against the repository's published .sha1 before it is accepted.
#
# usage: scripts/fetch-drivers.sh [target-dir]      (default: <service>/target/drivers, i.e. next to target/tabledb-jdbc.jar)
# Pinned versions live HERE and only here (override with env for experiments, e.g. TRINO_VERSION=480).
set -euo pipefail

POSTGRESQL_VERSION="${POSTGRESQL_VERSION:-42.7.13}"
TRINO_VERSION="${TRINO_VERSION:-483}"
OJDBC11_VERSION="${OJDBC11_VERSION:-23.26.3.0.0}"
REPO="${MAVEN_REPO:-https://repo1.maven.org/maven2}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$here/target/drivers}"
mkdir -p "$out"

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
sha1_of()   { if command -v sha1sum   >/dev/null 2>&1; then sha1sum   "$1" | cut -d' ' -f1; else shasum -a 1   "$1" | cut -d' ' -f1; fi; }

entries=()
fetch() { # type group artifact version class
  local type="$1" group="$2" artifact="$3" version="$4" cls="$5"
  local file="$artifact-$version.jar"
  local base="$REPO/${group//.//}/$artifact/$version/$file"
  echo "fetching $file" >&2
  curl -fsSL --retry 3 -o "$out/$file.part" "$base"
  local remote_sha1 local_sha1
  remote_sha1="$(curl -fsSL --retry 3 "$base.sha1" | tr -d '[:space:]' | cut -c1-40)"
  local_sha1="$(sha1_of "$out/$file.part")"
  if [ "$remote_sha1" != "$local_sha1" ]; then
    echo "SHA-1 mismatch for $file (repo=$remote_sha1 local=$local_sha1)" >&2
    rm -f "$out/$file.part"; exit 1
  fi
  mv "$out/$file.part" "$out/$file"
  local sum; sum="$(sha256_of "$out/$file")"
  echo "  sha256 $sum" >&2
  entries+=("{\"type\":\"$type\",\"file\":\"$file\",\"sha256\":\"$sum\",\"version\":\"$version\",\"class\":\"$cls\"}")
}

fetch postgresql org.postgresql postgresql "$POSTGRESQL_VERSION" org.postgresql.Driver
fetch trino io.trino trino-jdbc "$TRINO_VERSION" io.trino.jdbc.TrinoDriver
fetch oracle com.oracle.database.jdbc ojdbc11 "$OJDBC11_VERSION" oracle.jdbc.OracleDriver

{
  printf '{"drivers":['
  first=1
  for e in "${entries[@]}"; do
    if [ $first -eq 1 ]; then first=0; else printf ','; fi
    printf '%s' "$e"
  done
  printf ']}\n'
} > "$out/manifest.json"
echo "wrote $out/manifest.json" >&2
