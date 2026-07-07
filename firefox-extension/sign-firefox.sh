#!/usr/bin/env bash
#
# Sign the HyperFetch Firefox add-on via Mozilla AMO (unlisted channel) so it can be
# installed permanently on a regular Firefox — no more "Load Temporary Add-on" every restart.
#
# Requirements:
#   - Node.js + npm (web-ext is run through `npx`, no global install needed)
#   - A free addons.mozilla.org account with API credentials:
#       https://addons.mozilla.org/developers/addon/api/key/
#     Copy the "JWT issuer" and "JWT secret" values.
#
# Usage:
#   export AMO_JWT_ISSUER="user:12345:67"
#   export AMO_JWT_SECRET="abcdef0123456789..."
#   ./sign-firefox.sh
#
# On success a signed .xpi is written to ./web-ext-artifacts/ and copied to
# ./hyperfetch.xpi. Open it in Firefox (or drag it onto the window) to install permanently.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

: "${AMO_JWT_ISSUER:?Set AMO_JWT_ISSUER (JWT issuer from https://addons.mozilla.org/developers/addon/api/key/)}"
: "${AMO_JWT_SECRET:?Set AMO_JWT_SECRET (JWT secret from https://addons.mozilla.org/developers/addon/api/key/)}"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm (Node.js) is required but was not found on PATH." >&2
  echo "Install Node.js: https://nodejs.org/" >&2
  exit 1
fi

# Some networks advertise IPv6 but black-hole it, which makes npm/Node hang on connect.
# Prefer IPv4 and disable Happy-Eyeballs auto-selection so npm reliably reaches the registry.
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first --no-network-family-autoselection"

# Install web-ext locally once and reuse it (avoids re-downloading via npx on every run).
WEB_EXT="$SCRIPT_DIR/node_modules/.bin/web-ext"
if [[ ! -x "$WEB_EXT" ]]; then
  echo "Installing web-ext locally (first run only)..."
  npm install --no-save --fund=false --audit=false --no-progress web-ext@latest
fi

echo "Signing HyperFetch (unlisted) via AMO..."
echo "  Source: $SCRIPT_DIR"

# --channel=unlisted signs the add-on for self-distribution without publishing it to the store.
"$WEB_EXT" sign \
  --source-dir "$SCRIPT_DIR" \
  --artifacts-dir "$SCRIPT_DIR/web-ext-artifacts" \
  --channel unlisted \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"

# web-ext names the file after the extension id + version; copy the newest to a stable name.
SIGNED_XPI="$(ls -t "$SCRIPT_DIR"/web-ext-artifacts/*.xpi 2>/dev/null | head -n1 || true)"
if [[ -n "$SIGNED_XPI" ]]; then
  cp -f "$SIGNED_XPI" "$SCRIPT_DIR/hyperfetch.xpi"
  echo
  echo "Done. Signed add-on:"
  echo "  $SIGNED_XPI"
  echo "  copied to: $SCRIPT_DIR/hyperfetch.xpi"
  echo
  echo "Install it permanently:"
  echo "  1. Open Firefox and go to about:addons"
  echo "  2. Click the gear icon -> 'Install Add-on From File...'"
  echo "  3. Select: $SCRIPT_DIR/hyperfetch.xpi"
  echo "  (Or simply drag hyperfetch.xpi onto the Firefox window.)"
else
  echo "Warning: signing finished but no .xpi was found in web-ext-artifacts/." >&2
  exit 1
fi
