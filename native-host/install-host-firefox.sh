#!/usr/bin/env bash
set -euo pipefail

# Registers the HyperFetch native messaging host for Firefox.
#
# Firefox differs from Chrome in two ways:
#   1. The manifest uses "allowed_extensions" with the add-on's gecko ID (from
#      browser_specific_settings.gecko.id in the Firefox manifest.json), NOT a
#      chrome-extension:// origin.
#   2. The manifest is installed under ~/.mozilla/native-messaging-hosts/.
#
# The extension ID defaults to the one declared in firefox-extension/manifest.json.

EXTENSION_ID="${1:-hyperfetch@hyperfetch.local}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/native_host.py"
TEMPLATE="$SCRIPT_DIR/com.hyperfetch.host.firefox.template.json"

if [[ ! -f "$HOST_SCRIPT" ]]; then
  echo "Missing native host script: $HOST_SCRIPT"
  exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Missing host template: $TEMPLATE"
  exit 1
fi

chmod +x "$HOST_SCRIPT"

HOST_PATH_ESCAPED="${HOST_SCRIPT//\//\\/}"

render_manifest() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  sed \
    -e "s/__HOST_PATH__/${HOST_PATH_ESCAPED}/g" \
    -e "s/__EXTENSION_ID__/${EXTENSION_ID}/g" \
    "$TEMPLATE" > "$dest"
  echo "Installed Firefox native host manifest: $dest"
}

# Standard (non-sandboxed) Firefox location.
render_manifest "$HOME/.mozilla/native-messaging-hosts/com.hyperfetch.host.json"

# Snap Firefox (Ubuntu default) is confined and only reads native messaging hosts from its own
# per-snap home. Install there too if a Snap Firefox is present.
snap_firefox=false
if [[ -d "$HOME/snap/firefox" ]]; then
  snap_firefox=true
elif command -v snap >/dev/null 2>&1 && snap list firefox >/dev/null 2>&1; then
  snap_firefox=true
fi
if [[ "$snap_firefox" == true ]]; then
  render_manifest "$HOME/snap/firefox/common/.mozilla/native-messaging-hosts/com.hyperfetch.host.json"
  echo "Note: Snap Firefox detected. The host script must live under your home directory"
  echo "      (non-hidden path) so the Snap sandbox can execute it. Current path:"
  echo "      $HOST_SCRIPT"
fi

# Flatpak Firefox has its own sandboxed home as well.
if [[ -d "$HOME/.var/app/org.mozilla.firefox" ]]; then
  render_manifest "$HOME/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/com.hyperfetch.host.json"
  echo "Note: Flatpak Firefox detected. Grant filesystem access if needed:"
  echo "      flatpak override --user --filesystem=home org.mozilla.firefox"
fi

echo "Allowed extension ID: $EXTENSION_ID"
