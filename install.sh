#!/usr/bin/env bash
#
# HyperFetch one-step setup.
#
# The extensions ship with fixed IDs in chrome-extension/manifest.json (Chrome),
# edge-extension/manifest.json (Edge), and firefox-extension/manifest.json (Firefox), so all
# extension IDs are constant on every machine. This script registers the native messaging host
# for all supported browsers — no manual
# lookup required.
#
# Usage:
#   ./install.sh            # register native host for Chrome, Edge, and Firefox (best-effort)
#   ./install.sh chrome     # Chrome only
#   ./install.sh edge       # Edge only
#   ./install.sh firefox    # Firefox only
#
set -euo pipefail

# Fixed extension IDs derived from the extension manifests.
EXTENSION_ID="ekhohmoicafiheojabajlkkfibppajic"
EDGE_EXTENSION_ID="janjffcbkocmjgakkoapljjgfbmppilb"
FIREFOX_EXTENSION_ID="hyperfetch@hyperfetch.local"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-both}"

case "$TARGET" in
  chrome|edge|firefox|both) ;;
  *)
    echo "Usage: $0 [chrome|edge|firefox|both]" >&2
    exit 1
    ;;
esac

echo "HyperFetch setup ($TARGET)"
echo

did_chrome=false
did_edge=false
did_firefox=false

if [[ "$TARGET" == "chrome" || "$TARGET" == "both" ]]; then
  echo "== Chrome =="
  echo "  Extension ID: $EXTENSION_ID"
  "$SCRIPT_DIR/native-host/install-host.sh" "$EXTENSION_ID"
  did_chrome=true
  echo
fi

if [[ "$TARGET" == "edge" || "$TARGET" == "both" ]]; then
  echo "== Edge =="
  echo "  Extension ID: $EDGE_EXTENSION_ID"
  if [[ -f "$SCRIPT_DIR/native-host/install-host-edge.sh" ]]; then
    "$SCRIPT_DIR/native-host/install-host-edge.sh" "$EDGE_EXTENSION_ID"
    did_edge=true
  else
    echo "  Skipped: native-host/install-host-edge.sh not found."
  fi
  echo
fi

if [[ "$TARGET" == "firefox" || "$TARGET" == "both" ]]; then
  echo "== Firefox =="
  echo "  Extension ID: $FIREFOX_EXTENSION_ID"
  if [[ -f "$SCRIPT_DIR/native-host/install-host-firefox.sh" ]]; then
    "$SCRIPT_DIR/native-host/install-host-firefox.sh" "$FIREFOX_EXTENSION_ID"
    did_firefox=true
  else
    echo "  Skipped: native-host/install-host-firefox.sh not found."
  fi
  echo
fi

echo "Done."

if [[ "$did_chrome" == true ]]; then
  echo
  echo "Next steps in Chrome:"
  echo "  1. Open chrome://extensions/"
  echo "  2. Enable Developer mode (top-right)"
  echo "  3. Click 'Load unpacked' and select: $SCRIPT_DIR/chrome-extension"
  echo "  4. Confirm the ID shows as: $EXTENSION_ID"
  echo "  5. Open the extension settings and click 'Test Native Host'"
fi

if [[ "$did_edge" == true ]]; then
  echo
  echo "Next steps in Edge:"
  echo "  1. Open edge://extensions/"
  echo "  2. Enable Developer mode (left sidebar)"
  echo "  3. Click 'Load unpacked' and select: $SCRIPT_DIR/edge-extension"
  echo "  4. Confirm the ID shows as: $EDGE_EXTENSION_ID"
  echo "  5. Open the extension settings and click 'Test Native Host'"
fi

if [[ "$did_firefox" == true ]]; then
  echo
  echo "Next steps in Firefox:"
  echo "  1. Open about:debugging#/runtime/this-firefox"
  echo "  2. Click 'Load Temporary Add-on' and select: $SCRIPT_DIR/firefox-extension/manifest.json"
  echo "  3. Confirm the Extension ID shows as: $FIREFOX_EXTENSION_ID"
  echo "  4. Open the extension settings and click 'Test Native Host'"
  echo
  echo "  Note: Snap/Flatpak Firefox cannot launch native messaging hosts. If Test Native Host"
  echo "        fails, install the non-snap Firefox (Mozilla APT .deb or tarball)."
fi
