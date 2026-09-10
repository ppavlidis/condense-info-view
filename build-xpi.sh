#!/usr/bin/env bash
# Packages the plugin as an XPI file that can be installed via Zotero → Tools → Add-ons.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$PLUGIN_DIR/condense-info-view.xpi"

cd "$PLUGIN_DIR"
# zip appends to an existing archive, so a stale XPI would keep files that have
# since been renamed or deleted. Start from nothing every time.
rm -f "$OUT"
zip -r "$OUT" manifest.json bootstrap.js condense-info-view.js style.css content/ \
	-x '*.DS_Store'

echo "Built: $OUT"
