#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <edge_extension_id>"
  exit 1
fi

EXTENSION_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/native_host.py"
TEMPLATE="$SCRIPT_DIR/com.hyperfetch.host.edge.template.json"

if [[ ! -f "$HOST_SCRIPT" ]]; then
  echo "Missing native host script: $HOST_SCRIPT"
  exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Missing host template: $TEMPLATE"
  exit 1
fi

chmod +x "$HOST_SCRIPT"

if [[ "${XDG_CONFIG_HOME:-}" != "" ]]; then
  EDGE_HOST_DIR="$XDG_CONFIG_HOME/microsoft-edge/NativeMessagingHosts"
else
  EDGE_HOST_DIR="$HOME/.config/microsoft-edge/NativeMessagingHosts"
fi

mkdir -p "$EDGE_HOST_DIR"

HOST_MANIFEST="$EDGE_HOST_DIR/com.hyperfetch.host.json"
HOST_PATH_ESCAPED="${HOST_SCRIPT//\//\\/}"

sed \
  -e "s/__HOST_PATH__/${HOST_PATH_ESCAPED}/g" \
  -e "s/__EXTENSION_ID__/${EXTENSION_ID}/g" \
  "$TEMPLATE" > "$HOST_MANIFEST"

echo "Installed Edge native host manifest: $HOST_MANIFEST"
echo "Allowed extension ID: $EXTENSION_ID"
