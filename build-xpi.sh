#!/usr/bin/env bash
# Packages the plugin as an XPI file that can be installed via Zotero → Tools → Add-ons.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$PLUGIN_DIR/condense-info-view.xpi"

cd "$PLUGIN_DIR"
zip -r "$OUT" manifest.json bootstrap.js condense-info-view.js style.css

echo "Built: $OUT"
