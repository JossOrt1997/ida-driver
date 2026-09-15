#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npm ci
npm run check
npm test -- --runInBand
npm audit --omit=dev
rm -rf dist
mkdir -p dist
npm run build:linux
npm run build:win
sha256sum dist/* > dist/SHA256SUMS
echo "Release preparada en $ROOT_DIR/dist"
