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

echo "Checking packed npm artifacts for unresolved workspace: references..."

found=0
checked=0
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
  packed_manifest="$PACK_DIR/${pkg_name//\//-}.package.json"
  tar -xOf "$tarball" package/package.json > "$packed_manifest"

  if ! check_manifest "$packed_manifest" "$pkg_name packed package.json"; then
    found=1
  fi
  checked=$((checked + 1))
done < <(find "$ROOT_DIR/packages" -mindepth 2 -maxdepth 2 -name 'package.json' -not -path '*/node_modules/*' | sort)

if [ "$found" -eq 1 ]; then
  echo ""
  echo "FAIL: packed npm artifacts contain unresolved workspace: references."
  exit 1
fi

echo "OK: Checked $checked packed package artifact(s); no unresolved workspace: references found."
