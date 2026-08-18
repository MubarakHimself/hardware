#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
lock_file="${repo_root}/resources/postgres/provenance.lock.json"
cache_dir="${repo_root}/.desktop-cache"
vendor_root="${repo_root}/vendor/postgres"
destination="${vendor_root}/linux-x64"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "PostgreSQL linux-x64 must be built on an x86_64 Linux host." >&2
  exit 1
fi

for command in node curl sha256sum tar make cc strip ldd file patchelf; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required build command is missing: ${command}" >&2
    exit 1
  fi
done

readarray -t provenance < <(
  node -e '
    const lock = require(process.argv[1]);
    const target = lock.postgresql.targets["linux-x64"];
    console.log(lock.postgresql.version);
    console.log(target.url);
    console.log(target.fileName);
    console.log(target.size);
    console.log(target.sha256);
  ' "${lock_file}"
)

postgres_version="${provenance[0]}"
source_url="${provenance[1]}"
archive_name="${provenance[2]}"
expected_size="${provenance[3]}"
expected_sha="${provenance[4]}"

mkdir -p -- "${cache_dir}" "${vendor_root}"
archive_path="${cache_dir}/${archive_name}"

if [[ ! -f "${archive_path}" ]]; then
  partial_path="${archive_path}.partial"
  rm -f -- "${partial_path}"
  curl --fail --location --retry 3 --output "${partial_path}" "${source_url}"
  mv -- "${partial_path}" "${archive_path}"
fi

actual_size="$(stat --format='%s' "${archive_path}")"
if [[ "${actual_size}" != "${expected_size}" ]]; then
  echo "PostgreSQL source length mismatch: expected ${expected_size}, received ${actual_size}" >&2
  exit 1
fi

echo "${expected_sha}  ${archive_path}" | sha256sum --check --strict -

work_dir="$(mktemp -d "${cache_dir}/postgres-build-XXXXXX")"
case "${work_dir}" in
  "${cache_dir}"/postgres-build-*) ;;
  *)
    echo "Refusing unsafe PostgreSQL work directory: ${work_dir}" >&2
    exit 1
    ;;
esac

cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

tar -xjf "${archive_path}" -C "${work_dir}"
source_dir="${work_dir}/postgresql-${postgres_version}"
install_dir="${work_dir}/install"

cd -- "${source_dir}"
export CFLAGS="${CFLAGS:--O2 -fstack-protector-strong -D_FORTIFY_SOURCE=3}"
export LDFLAGS="${LDFLAGS:--Wl,-z,relro,-z,now}"

./configure \
  --prefix="${install_dir}" \
  --without-readline \
  --without-icu \
  --without-llvm \
  --without-lz4 \
  --without-zstd \
  --without-ssl \
  --disable-rpath \
  --with-zlib

make -s -j"$(nproc)"
make -s install
make -s -C contrib/pg_trgm -j"$(nproc)"
make -s -C contrib/pg_trgm install

cp -- "${source_dir}/COPYRIGHT" "${install_dir}/COPYRIGHT"
rm -rf -- "${install_dir}/include" "${install_dir}/lib/pgxs"

while IFS= read -r -d '' executable; do
  if file --brief "${executable}" | grep -q 'ELF'; then
    patchelf --set-rpath '$ORIGIN/../lib' "${executable}"
  fi
done < <(find "${install_dir}/bin" -type f -print0)

while IFS= read -r -d '' library; do
  if file --brief "${library}" | grep -q 'ELF'; then
    patchelf --set-rpath '$ORIGIN' "${library}"
  fi
done < <(find "${install_dir}/lib" -type f -print0)

find "${install_dir}/bin" -type f -exec strip --strip-unneeded {} + 2>/dev/null || true
find "${install_dir}/lib" -type f -name '*.so*' -exec strip --strip-unneeded {} + 2>/dev/null || true

required_files=(
  "bin/postgres"
  "bin/initdb"
  "bin/pg_ctl"
  "bin/pg_dump"
  "bin/pg_restore"
  "bin/pg_isready"
  "lib/pg_trgm.so"
  "share/extension/pg_trgm.control"
)
for required_file in "${required_files[@]}"; do
  if [[ ! -f "${install_dir}/${required_file}" ]]; then
    echo "Built PostgreSQL runtime is missing ${required_file}" >&2
    exit 1
  fi
done

reported_version="$("${install_dir}/bin/postgres" --version)"
if [[ "${reported_version}" != *"${postgres_version}"* ]]; then
  echo "Built postgres reported an unexpected version: ${reported_version}" >&2
  exit 1
fi

unexpected_dependencies="$(
  {
    ldd "${install_dir}/bin/postgres"
    ldd "${install_dir}/bin/pg_dump"
    ldd "${install_dir}/lib/pg_trgm.so"
  } |
    awk -v bundled="${install_dir}/lib/" '
      /not found/ { print; next }
      /=> \// {
        name = $1
        path = $3
        if (index(path, bundled) == 1) next
        if (name ~ /^(libc|libm|libpthread|libdl|librt|libz)\.so/) next
        print name " => " path
      }
    ' |
    sort -u || true
)"
if [[ -n "${unexpected_dependencies}" ]]; then
  echo "Unexpected PostgreSQL shared-library dependencies:" >&2
  echo "${unexpected_dependencies}" >&2
  exit 1
fi

cp -- "${lock_file}" "${install_dir}/PROVENANCE.json"

case "${destination}" in
  "${vendor_root}"/linux-x64) ;;
  *)
    echo "Refusing unsafe PostgreSQL destination: ${destination}" >&2
    exit 1
    ;;
esac
rm -rf -- "${destination}"
mv -- "${install_dir}" "${destination}"

echo "PostgreSQL ${postgres_version} is ready at ${destination}."
