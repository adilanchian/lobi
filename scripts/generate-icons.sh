#!/usr/bin/env bash
# Generates .icns files from the dock PNGs.
# Requires: sips and iconutil (macOS built-ins)
#
# Usage:
#   ./scripts/generate-icons.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSETS_MAC="$REPO_ROOT/assets/macOS"

make_icns() {
  local src="$1"
  local out="$2"
  local tmp; tmp=$(mktemp -d)
  local iconset="$tmp/icon.iconset"
  mkdir -p "$iconset"

  for size in 16 32 64 128 256 512 1024; do
    sips -z "$size" "$size" "$src" --out "$iconset/icon_${size}x${size}.png" -s format png > /dev/null
  done
  for size in 16 32 128 256 512; do
    local double=$((size * 2))
    sips -z "$double" "$double" "$src" --out "$iconset/icon_${size}x${size}@2x.png" -s format png > /dev/null
  done

  iconutil -c icns "$iconset" -o "$out"
  rm -rf "$tmp"
  echo "✅  $out"
}

make_icns "$ASSETS_MAC/icon-light-dock.png" "$ASSETS_MAC/icon-light.icns"
make_icns "$ASSETS_MAC/icon-dark-dock.png"  "$ASSETS_MAC/icon-dark.icns"

echo "🎉  Done."
