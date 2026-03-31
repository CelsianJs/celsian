#!/usr/bin/env bash
# verify-publish.sh — Ensure no workspace:* protocol strings remain in package.json
# files before publishing to npm. The workspace: protocol is a pnpm feature that
# must be resolved to real version ranges before publish.

set -euo pipefail

echo "Checking for unresolved workspace: references..."

found=0
while IFS= read -r file; do
  if grep -q '"workspace:' "$file"; then
    echo "ERROR: $file contains workspace: references"
    grep '"workspace:' "$file"
    found=1
  fi
done < <(find packages -name 'package.json' -not -path '*/node_modules/*')

if [ "$found" -eq 1 ]; then
  echo ""
  echo "FAIL: workspace:* references must be resolved before publishing."
  echo "Run 'pnpm publish' which auto-resolves them, or use changesets."
  exit 1
fi

echo "OK: No unresolved workspace: references found."
