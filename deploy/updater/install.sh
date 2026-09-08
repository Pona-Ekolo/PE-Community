#!/bin/sh
set -eu

repository='Pona-Ekolo/PE-Community'
version=''
project_dir=''
mode='install'

usage() {
  echo "Usage: sudo ./deploy/updater/install.sh [--project-dir DIR] [--version vX.Y.Z] [--repair|--uninstall]" >&2
  exit 64
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-dir) project_dir=${2-}; shift 2 ;;
    --version) version=${2-}; shift 2 ;;
    --repair) mode='repair'; shift ;;
    --uninstall) mode='uninstall'; shift ;;
    *) usage ;;
  esac
done

fail() { printf '%s\n' "$1" >&2; exit 1; }
safe_value() {
  case "$1" in *"
"*|*""*|*"$(printf '\t')"*) return 1;; esac
}
safe_path() {
  safe_value "$1" || return 1
  case "$1" in /*) ;; *) return 1;; esac
  printf '%s' "$1" | grep -Eq '^/[A-Za-z0-9._/-]+$'
}
require_root() { [ "$(id -u)" -eq 0 ] || fail 'Run this installer with sudo or as root.'; }
project_root() {
  candidate=${project_dir:-$(pwd -P)}
  safe_value "$candidate" || fail 'Invalid project path.'
  [ -d "$candidate" ] || fail 'PE Community project not found.'
  candidate=$(CDPATH= cd -- "$candidate" && pwd -P)
  safe_path "$candidate" || fail 'Invalid project path.'
  [ -f "$candidate/docker-compose.prod.yml" ] && [ -f "$candidate/.env" ] && [ -f "$candidate/deploy/Caddyfile" ] || fail 'PE Community project not found.'
  printf '%s\n' "$candidate"
}
architecture() {
  case "$(uname -m)" in x86_64) printf '%s\n' linux-amd64;; aarch64|arm64) printf '%s\n' linux-arm64;; *) fail 'Unsupported host architecture.';; esac
}
fail_code() {
  code=$1 message=$2
  printf '%s: %s\n' "$code" "$message" >&2
  exit 1
}
is_stable_semver() {
  printf '%s' "$1" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
}
set_env() {
  file=$1 key=$2 value=$3 temporary="$file.tmp.$$"
  safe_value "$value" || fail 'Invalid configuration value.'
  awk -v key="$key" -v value="$value" '
    BEGIN { written=0 }
    index($0, key "=") == 1 { if (!written) { print key "=" value; written=1 }; next }
    { print }
    END { if (!written) print key "=" value }
  ' "$file" > "$temporary"
  chmod "$(stat -c '%a' "$file")" "$temporary"
  chown "$(stat -c '%u:%g' "$file")" "$temporary"
  mv "$temporary" "$file"
}
remove_env() {
  file=$1 key=$2 temporary="$file.tmp.$$"
  awk -v key="$key" 'index($0, key "=") != 1 { print }' "$file" > "$temporary"
  chmod "$(stat -c '%a' "$file")" "$temporary"
  chown "$(stat -c '%u:%g' "$file")" "$temporary"
  mv "$temporary" "$file"
}
release_json() {
  endpoint=$1
  command -v curl >/dev/null 2>&1 || fail 'curl is required to install the updater.'
  command -v jq >/dev/null 2>&1 || fail 'jq is required to install the updater.'
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "https://api.github.com/repos/$repository/$endpoint"
}
release_contract_problem() {
  release=$1 tag=$2
  is_stable_semver "$tag" || { printf '%s\n' UPDATER_RELEASE_INELIGIBLE; return 1; }
  printf '%s' "$release" | jq -e --arg tag "$tag" '
    .tag_name == $tag and .draft == false and .prerelease == false and
    (.published_at | type == "string")
  ' >/dev/null || { printf '%s\n' UPDATER_RELEASE_INELIGIBLE; return 1; }
  for asset in \
    pe-community-update-manifest.json \
    pe-community-update-manifest.attestation.json \
    "pe-community-updater-$tag-linux-amd64.tar.gz" \
    "pe-community-updater-$tag-linux-arm64.tar.gz"; do
    count=$(printf '%s' "$release" | jq -r --arg asset "$asset" '[.assets[]? | select(.name == $asset)] | length')
    [ "$count" = 1 ] || { printf '%s\n' UPDATER_ASSET_MISSING; return 1; }
    digest=$(printf '%s' "$release" | jq -r --arg asset "$asset" '[.assets[]? | select(.name == $asset)] | .[0].digest // empty')
    printf '%s' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || { printf '%s\n' UPDATER_ASSET_DIGEST_MISSING; return 1; }
  done
}
select_eligible_release() {
  page=1
  while [ "$page" -le 3 ]; do
    releases=$(release_json "releases?per_page=100&page=$page") || fail_code UPDATER_RELEASE_NOT_FOUND 'No compatible stable updater release is available.'
    count=$(printf '%s' "$releases" | jq -r 'if type == "array" then length else 0 end')
    [ "$count" -gt 0 ] || break
    tags=$(printf '%s' "$releases" | jq -r '.[]? | .tag_name // empty')
    for tag in $tags; do
      is_stable_semver "$tag" || continue
      release=$(printf '%s' "$releases" | jq -c --arg tag "$tag" '.[] | select(.tag_name == $tag)')
      if problem=$(release_contract_problem "$release" "$tag"); then
        printf '%s\n' "$tag"
        return 0
      fi
    done
    [ "$count" -lt 100 ] && break
    page=$((page + 1))
  done
  fail_code UPDATER_RELEASE_NOT_FOUND 'No compatible stable updater release is available.'
}
select_pinned_release() {
  tag=$1
  is_stable_semver "$tag" || fail_code UPDATER_RELEASE_INELIGIBLE 'Updater version must be strict stable semver.'
  release=$(release_json "releases/tags/$tag") || fail_code UPDATER_RELEASE_NOT_FOUND "Updater release $tag was not found."
  if problem=$(release_contract_problem "$release" "$tag"); then
    printf '%s\n' "$release"
    return 0
  fi
  case "$problem" in
    UPDATER_ASSET_MISSING) fail_code "$problem" "Updater package contract is incomplete for $tag.";;
    UPDATER_ASSET_DIGEST_MISSING) fail_code "$problem" "Updater package digest metadata is missing for $tag.";;
    *) fail_code UPDATER_RELEASE_INELIGIBLE "Updater release $tag is not an eligible stable updater release.";;
  esac
}
release_asset() {
  release=$1 tag=$2 asset=$3 destination=$4
  url=$(printf '%s' "$release" | jq -r --arg asset "$asset" '[.assets[]? | select(.name == $asset)] | .[0].browser_download_url // empty')
  digest=$(printf '%s' "$release" | jq -r --arg asset "$asset" '[.assets[]? | select(.name == $asset)] | .[0].digest // empty')
  [ -n "$url" ] || fail_code UPDATER_ASSET_MISSING "Updater package for $arch is missing from $tag."
  printf '%s' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || fail_code UPDATER_ASSET_DIGEST_MISSING "Updater package digest metadata is missing for $tag."
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$url" --output "$destination" || fail_code UPDATER_ASSET_DOWNLOAD_FAILED "Updater package download failed for $tag."
  actual=$(sha256sum "$destination" | awk '{print $1}')
  [ "sha256:$actual" = "$digest" ] || fail_code UPDATER_ASSET_DIGEST_MISMATCH "Updater package verification failed for $tag."
}
validate_bundled_gh_elf() {
  binary=$1 target_arch=$2
  [ -f "$binary" ] && [ ! -L "$binary" ] && [ -x "$binary" ] || fail_code UPDATER_BUNDLE_NOT_ELF 'Bundled updater executable is invalid.'
  header=$(od -An -N20 -tx1 "$binary" 2>/dev/null | tr -d '[:space:]') || fail_code UPDATER_BUNDLE_NOT_ELF 'Bundled updater executable is invalid.'
  printf '%s' "$header" | grep -Eq '^[0-9a-f]{40}$' || fail_code UPDATER_BUNDLE_NOT_ELF 'Bundled updater executable is invalid.'
  magic=$(printf '%s' "$header" | cut -c1-8)
  elf_class=$(printf '%s' "$header" | cut -c9-10)
  data_encoding=$(printf '%s' "$header" | cut -c11-12)
  machine=$(printf '%s' "$header" | cut -c37-40)
  [ "$magic" = 7f454c46 ] && [ "$elf_class" = 02 ] || fail_code UPDATER_BUNDLE_NOT_ELF 'Bundled updater executable is invalid.'
  case "$data_encoding" in
    01)
      case "$target_arch" in linux-amd64) expected_machine=3e00;; linux-arm64) expected_machine=b700;; *) fail 'Unsupported host architecture.';; esac
      ;;
    02)
      case "$target_arch" in linux-amd64) expected_machine=003e;; linux-arm64) expected_machine=00b7;; *) fail 'Unsupported host architecture.';; esac
      ;;
    *) fail_code UPDATER_BUNDLE_NOT_ELF 'Bundled updater executable is invalid.';;
  esac
  [ "$machine" = "$expected_machine" ] || fail_code UPDATER_BUNDLE_ARCHITECTURE_MISMATCH 'Bundled updater architecture does not match this host.'
}
validate_bundled_gh_version() {
  binary=$1
  "$binary" version | head -n1 | grep -Eq '^gh version 2\.93\.0 ' || fail_code UPDATER_BUNDLED_GH_VERSION_MISMATCH 'Bundled GitHub CLI version is invalid.'
}
install_bundle() {
  project=$1 archive=$2 target_arch=$3
  install_root="$project/.pe/updater"
  stage=$(mktemp -d "${TMPDIR:-/tmp}/pe-community-updater.XXXXXX")
  trap 'rm -rf "$stage"' EXIT HUP INT TERM
  tar -xzf "$archive" -C "$stage" || fail_code UPDATER_BUNDLE_INVALID 'Updater package is invalid.'
  package="$stage/pe-community-updater"
  entries=$(tar -tzf "$archive") || fail_code UPDATER_BUNDLE_INVALID 'Updater package is invalid.'
  printf '%s\n' "$entries" | grep -Eq '^pe-community-updater/(bin/pe-community-updater|bin/gh|dist/cli.js|dist/server.js|deploy/install.sh)$' || fail_code UPDATER_BUNDLE_INVALID 'Updater package is invalid.'
  printf '%s\n' "$entries" | grep -Eq '(^/|(^|/)\.\.(/|$))' && fail_code UPDATER_BUNDLE_INVALID 'Updater package is invalid.'
  [ -f "$package/bin/pe-community-updater" ] || fail_code UPDATER_BUNDLE_INVALID 'Updater package is invalid.'
  validate_bundled_gh_elf "$package/bin/gh" "$target_arch"
  validate_bundled_gh_version "$package/bin/gh"
  mkdir -p "$project/.pe"
  chown root:root "$project/.pe"
  chmod 0755 "$project/.pe"
  rm -rf "$install_root.next"
  mv "$package" "$install_root.next"
  chown -R root:root "$install_root.next"
  chmod -R go-w "$install_root.next"
  chmod 0755 "$install_root.next" "$install_root.next/bin" "$install_root.next/bin/pe-community-updater" "$install_root.next/bin/gh"
  if [ -d "$install_root" ]; then rm -rf "$install_root.previous"; mv "$install_root" "$install_root.previous"; fi
  mv "$install_root.next" "$install_root"
  printf '%s\n' "$install_root"
}
install_unit() {
  template=$1 destination=$2 project=$3 root=$4
  state="$root/state" backup="$root/backups" runtime='/run/pe-community-updater'
  for path in "$project" "$root" "$state" "$backup" "$runtime"; do
    safe_path "$path" || fail 'Invalid updater path.'
  done
  awk -v project="$project" -v root="$root" -v state="$state" -v backup="$backup" -v runtime="$runtime" '
    { gsub("@PE_UPDATER_PROJECT_ROOT@", project); gsub("@PE_UPDATER_ROOT@", root); gsub("@PE_UPDATER_STATE_DIR@", state); gsub("@PE_UPDATER_BACKUP_ROOT@", backup); gsub("@PE_UPDATER_RUNTIME_DIR@", runtime); print }
  ' "$template" > "$destination"
  grep -q '@PE_UPDATER_' "$destination" && fail 'Updater service template is invalid.'
  chmod 0644 "$destination"
}

if [ "${PE_UPDATER_INSTALLER_LIBRARY:-}" = 1 ]; then
  return 0 2>/dev/null || exit 0
fi

require_root
project=$(project_root)

if [ "$mode" = uninstall ]; then
  systemctl disable --now pe-community-updater.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/pe-community-updater.service /etc/pe-community-updater/updater.env
  rmdir /etc/pe-community-updater 2>/dev/null || true
  for key in PE_UPDATER_SHARED_SECRET PE_UPDATER_SOCKET PE_UPDATER_RUNTIME_DIR PE_UPDATER_SOCKET_GID PE_UPDATER_COMPOSE_OVERRIDE; do
    remove_env "$project/.env" "$key"
  done
  systemctl daemon-reload
  docker compose --env-file "$project/.env" -f "$project/docker-compose.prod.yml" up -d --no-deps api
  printf '%s\n' 'PE Community Updater removed. Application data was not changed.'
  exit 0
fi

arch=$(architecture)
current=$(awk -F= '$1 == "PE_COMMUNITY_VERSION" { gsub(/"/, "", $2); print $2; exit }' "$project/.env")
[ -n "$current" ] || fail 'PE Community version is missing from .env.'
if [ -n "$version" ]; then
  release=$(select_pinned_release "$version")
else
  version=$(select_eligible_release)
  release=$(release_json "releases/tags/$version") || fail_code UPDATER_RELEASE_NOT_FOUND 'No compatible stable updater release is available.'
fi

archive=$(mktemp "${TMPDIR:-/tmp}/pe-community-updater.XXXXXX.tar.gz")
release_asset "$release" "$version" "pe-community-updater-$version-$arch.tar.gz" "$archive"
getent group pe-community-updater >/dev/null 2>&1 || groupadd --system pe-community-updater
command -v node >/dev/null 2>&1 || fail 'Node.js is required to run the updater.'
root=$(install_bundle "$project" "$archive" "$arch")
mkdir -p "$root/state" "$root/backups"
chown root:root "$root/state" "$root/backups"
chmod 0700 "$root/state" "$root/backups"
install -d -m 0750 -o root -g pe-community-updater /run/pe-community-updater
install -d -m 0700 -o root -g root /etc/pe-community-updater

secret=$(awk -F= '$1 == "PE_UPDATER_SHARED_SECRET" { print substr($0, index($0, "=") + 1); exit }' "$project/.env")
if [ "${#secret}" -lt 32 ]; then secret=$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n'); fi
set_env "$project/.env" PE_UPDATER_SHARED_SECRET "$secret"
set_env "$project/.env" PE_UPDATER_SOCKET /run/pe-community-updater/updater.sock
set_env "$project/.env" PE_UPDATER_RUNTIME_DIR /run/pe-community-updater
set_env "$project/.env" PE_UPDATER_SOCKET_GID "$(getent group pe-community-updater | awk -F: '{print $3}')"
set_env "$project/.env" PE_UPDATER_COMPOSE_OVERRIDE "$root/docker-compose.updater.yml"
install -m 0644 "$root/deploy/docker-compose.updater.yml" "$root/docker-compose.updater.yml"
cat > /etc/pe-community-updater/updater.env <<EOF
PE_UPDATER_SHARED_SECRET=$secret
PE_UPDATER_SHARED_SECRET_PREVIOUS=
PE_UPDATER_PROJECT_ROOT=$project
PE_UPDATER_DEPLOYMENT_ROOT=$project
PE_UPDATER_ROOT=$root
PE_UPDATER_STATE_DIR=$root/state
PE_UPDATER_BACKUP_ROOT=$root/backups
PE_UPDATER_RUNTIME_DIR=/run/pe-community-updater
PE_UPDATER_SOCKET=/run/pe-community-updater/updater.sock
PE_UPDATER_COMPOSE_OVERRIDE=$root/docker-compose.updater.yml
PE_UPDATER_MINIMUM_FREE_BYTES=5368709120
PE_UPDATER_BACKUP_RETENTION=5
PE_UPDATER_API_HEALTH_URL=http://127.0.0.1/api/v1/health
PE_UPDATER_WEB_HEALTH_URL=http://127.0.0.1/login
EOF
chmod 0600 /etc/pe-community-updater/updater.env
install_unit "$root/deploy/pe-community-updater.service" /etc/systemd/system/pe-community-updater.service "$project" "$root"
systemctl daemon-reload
systemctl enable --now pe-community-updater.service
docker compose --env-file "$project/.env" -f "$project/docker-compose.prod.yml" -f "$root/docker-compose.updater.yml" up -d --no-deps api
printf '%s\n' 'PE Community Updater'
printf '%s\n' "[ok] Application version: $current" "[ok] Updater package: $version" "[ok] Architecture: $arch" "[ok] Updater verified" "[ok] Updater installed" "[ok] Service running" "[ok] API connected" "[ok] Application remains $current" '' 'Updater installation complete.' 'No application update was performed.'
