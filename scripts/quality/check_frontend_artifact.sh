#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR="${1:-}"

if [ -z "$ARTIFACT_DIR" ] || [ ! -d "$ARTIFACT_DIR" ]; then
    echo "Usage: $0 FRONTEND_ARTIFACT_DIR" >&2
    exit 2
fi

map_file="$(find "$ARTIFACT_DIR" -type f -name '*.map' -print -quit)"
if [ -n "$map_file" ]; then
    echo "Public frontend artifact contains a source map: $map_file" >&2
    exit 1
fi

echo "Frontend artifact contains no public source maps."
