#!/usr/bin/env bash
# Builds dist/qa-buddy-<version>.zip for the Chrome Web Store (manifest.json at the top level).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json; print(json.load(open('extension/manifest.json'))['version'])")
mkdir -p dist
OUT="dist/qa-buddy-${VERSION}.zip"
rm -f "$OUT"
(cd extension && zip -rq "../$OUT" . -x "*.DS_Store")
echo "Created $OUT"
