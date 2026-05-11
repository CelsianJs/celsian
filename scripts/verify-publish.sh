#!/usr/bin/env bash
# verify-publish.sh — Verify publishable package artifacts are npm-safe.
#
# Source package.json files may legitimately contain pnpm workspace:* ranges.
# pnpm resolves those ranges when creating publish artifacts, so this gate
# checks the packed tarball package.json files instead of the source manifests.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$PACK_DIR"
}
trap cleanup EXIT

is_private_package() {
  node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(pkg.private ? 0 : 1)' "$1"
}

package_name() {
  node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(pkg.name || process.argv[1])' "$1"
}

check_manifest() {
  local manifest="$1"
  local label="$2"

  if grep -q '"workspace:' "$manifest"; then
    echo "ERROR: $label contains unresolved workspace: references"
    grep '"workspace:' "$manifest"
    return 1
  fi
}

check_required_package_file() {
  local tarball="$1"
  local pkg_name="$2"
  local required_path="$3"

  if ! tar -tf "$tarball" | grep -Fxq "package/$required_path"; then
    echo "ERROR: $pkg_name packed tarball is missing $required_path"
    return 1
  fi
}

echo "Checking packed npm artifacts for README/LICENSE payloads and unresolved workspace: references..."

found=0
checked=0
tarballs=()
importable_packages=()
bin_entries=()
while IFS= read -r manifest; do
  if is_private_package "$manifest"; then
    continue
  fi

  pkg_dir="$(dirname "$manifest")"
  pkg_name="$(package_name "$manifest")"
  before_count=$(find "$PACK_DIR" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')

  echo "Packing $pkg_name..."
  (
    cd "$pkg_dir"
    pnpm pack --pack-destination "$PACK_DIR" >/dev/null
  )

  after_count=$(find "$PACK_DIR" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')
  if [ "$after_count" -le "$before_count" ]; then
    echo "ERROR: pnpm pack did not produce a tarball for $pkg_name"
    found=1
    continue
  fi

  tarball="$(find "$PACK_DIR" -maxdepth 1 -name '*.tgz' -print0 | xargs -0 ls -t | head -n 1)"
  tarballs+=("$tarball")
  printf '%s\t%s\n' "$pkg_name" "$tarball" >> "$PACK_DIR/tarball-map.tsv"
  packed_manifest="$PACK_DIR/${pkg_name//\//-}.package.json"
  tar -xOf "$tarball" package/package.json > "$packed_manifest"

  if ! check_required_package_file "$tarball" "$pkg_name" "README.md"; then
    found=1
  fi

  if ! check_required_package_file "$tarball" "$pkg_name" "LICENSE"; then
    found=1
  fi

  if ! check_manifest "$packed_manifest" "$pkg_name packed package.json"; then
    found=1
  fi

  if node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(pkg.exports ? 0 : 1)' "$packed_manifest"; then
    importable_packages+=("$pkg_name")
  else
    while IFS= read -r bin_name; do
      if [ -n "$bin_name" ]; then
        bin_entries+=("$pkg_name:$bin_name")
      fi
    done < <(node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const bin=pkg.bin; if (typeof bin === "string") console.log((pkg.name || "").split("/").pop()); else if (bin && typeof bin === "object") for (const key of Object.keys(bin)) console.log(key);' "$packed_manifest")
  fi
  checked=$((checked + 1))
done < <(find "$ROOT_DIR/packages" -mindepth 2 -maxdepth 2 -name 'package.json' -not -path '*/node_modules/*' | sort)

if [ "$found" -eq 1 ]; then
  echo ""
  echo "FAIL: packed npm artifacts are missing required README/LICENSE payloads or contain unresolved workspace: references."
  exit 1
fi

if [ "$checked" -eq 0 ]; then
  echo "ERROR: no publishable packages were checked"
  exit 1
fi

echo "Installing packed artifacts into a clean consumer project..."
CONSUMER_DIR="$PACK_DIR/consumer"
mkdir -p "$CONSUMER_DIR"
cat > "$CONSUMER_DIR/package.json" <<'JSON'
{
  "name": "celsian-packed-consumer-smoke",
  "private": true,
  "type": "module"
}
JSON
(
  cd "$CONSUMER_DIR"
  npm install --ignore-scripts --no-audit --no-fund "${tarballs[@]}" >/dev/null
)

if [ "${#importable_packages[@]}" -gt 0 ]; then
  printf '%s
' "${importable_packages[@]}" > "$PACK_DIR/importable-packages.txt"
  (
    cd "$CONSUMER_DIR"
    IMPORTABLE_PACKAGES_FILE="$PACK_DIR/importable-packages.txt" node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

const names = readFileSync(process.env.IMPORTABLE_PACKAGES_FILE, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

for (const name of names) {
  await import(name);
}
console.log(`OK: Imported ${names.length} package(s) from packed artifacts.`);
NODE
  )
fi

for entry in "${bin_entries[@]}"; do
  pkg_name="${entry%%:*}"
  bin_name="${entry#*:}"
  if [ ! -x "$CONSUMER_DIR/node_modules/.bin/$bin_name" ]; then
    echo "ERROR: expected binary $bin_name for $pkg_name was not installed"
    found=1
  fi
done

if [ "$found" -eq 1 ]; then
  echo ""
  echo "FAIL: packed npm artifacts failed consumer smoke verification."
  exit 1
fi

echo "Smoke-building generated projects from packed CLI artifacts..."
CREATE_CELSIAN_BIN="$CONSUMER_DIR/node_modules/.bin/create-celsian"
CELSIAN_BIN="$CONSUMER_DIR/node_modules/.bin/celsian"
NPM_CACHE_DIR="$PACK_DIR/npm-cache"
mkdir -p "$NPM_CACHE_DIR"
for tarball in "${tarballs[@]}"; do
  npm cache add --cache "$NPM_CACHE_DIR" "$tarball" >/dev/null
done

smoke_generated_app() {
  local app_dir="$1"
  local health_check="${2:-0}"
  (
    cd "$app_dir"
    # Install exactly the scaffolded app manifest; packed Celsian artifacts are only seeded in npm's cache.
    # This catches templates that import undeclared @celsian/* packages.
    npm install --prefer-offline --cache "$NPM_CACHE_DIR" --ignore-scripts --no-audit --no-fund >/dev/null
    npm run build >/dev/null
    if [ "$health_check" = "1" ]; then
      node "$ROOT_DIR/scripts/smoke-start-health.mjs"
    fi
  )
}

if [ ! -x "$CREATE_CELSIAN_BIN" ]; then
  echo "ERROR: create-celsian binary was not installed"
  found=1
else
  app_name="create-celsian-default-smoke"
  (cd "$CONSUMER_DIR" && "$CREATE_CELSIAN_BIN" "$app_name" >/dev/null)
  smoke_generated_app "$CONSUMER_DIR/$app_name" 1

  for template in full basic rest-api rpc-api; do
    app_name="create-celsian-$template-smoke"
    (cd "$CONSUMER_DIR" && "$CREATE_CELSIAN_BIN" "$app_name" --template "$template" >/dev/null)
    if [ "$template" = "full" ]; then
      smoke_generated_app "$CONSUMER_DIR/$app_name" 1
    else
      smoke_generated_app "$CONSUMER_DIR/$app_name"
    fi
  done
fi

if [ ! -x "$CELSIAN_BIN" ]; then
  echo "ERROR: celsian binary was not installed"
  found=1
else
  app_name="celsian-cli-default-smoke"
  (cd "$CONSUMER_DIR" && "$CELSIAN_BIN" create "$app_name" >/dev/null)
  smoke_generated_app "$CONSUMER_DIR/$app_name" 1

  for template in full basic rest-api rpc-api; do
    app_name="celsian-cli-$template-smoke"
    (cd "$CONSUMER_DIR" && "$CELSIAN_BIN" create "$app_name" --template "$template" >/dev/null)
    if [ "$template" = "full" ]; then
      smoke_generated_app "$CONSUMER_DIR/$app_name" 1
    else
      smoke_generated_app "$CONSUMER_DIR/$app_name"
    fi
  done
fi

if [ "$found" -eq 1 ]; then
  echo ""
  echo "FAIL: packed CLI scaffold smoke verification failed."
  exit 1
fi

echo "OK: Checked $checked packed package artifact(s); README/LICENSE payloads present; no unresolved workspace: references found; clean consumer install/import and generated app build smoke passed."
