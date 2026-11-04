#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/tryoncam-<version>.zip
#
#   npm run package:ext            first upload: includes key.pem, keeps the ID
#   npm run package:ext -- update  later versions: no key.pem
#
# The first upload carries the private key as key.pem so the store keeps the
# extension's ID (aadnmnhilcphhjnchilngaeandeldngc). Google sign-in's redirect
# URI and the landing page's install link are both bound to that ID. The
# "key" field itself is removed from the manifest: it is for unpacked loading.
#
# dist/ holds the private key during a first-upload build. It is gitignored and
# vercelignored; upload the zip only to the Chrome Web Store.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-first}"
npm run --silent build:sdk
VERSION=$(node -p "require('./extension/manifest.json').version")
STAGE=dist/extension
ZIP="dist/tryoncam-${VERSION}$([ "$MODE" = update ] && echo '' || echo '-first-upload').zip"

rm -rf "$STAGE" "$ZIP"
mkdir -p dist
cp -R extension "$STAGE"
find "$STAGE" -name '.DS_Store' -delete
node -e "
  const fs = require('fs');
  const p = '$STAGE/manifest.json';
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete m.key;
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
"
if [ "$MODE" != update ]; then
  cp .secrets/extension-private-key.pem "$STAGE/key.pem"
fi
(cd "$STAGE" && zip -qr "../$(basename "$ZIP")" . -x '.*')
rm -rf "$STAGE"
echo "Built $ZIP ($(du -h "$ZIP" | cut -f1))"
