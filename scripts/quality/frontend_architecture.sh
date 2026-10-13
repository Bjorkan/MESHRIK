#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"

required_packages=(
    "@tanstack/react-router"
    "@tanstack/react-query"
    "@tanstack/react-db"
    "@tanstack/query-db-collection"
    "@tanstack/react-store"
    "@tanstack/store"
    "@tanstack/react-table"
    "@tanstack/charts"
    "@tanstack/react-form"
    "@tanstack/react-virtual"
    "@tanstack/react-pacer"
    "@tanstack/react-hotkeys"
)

for package_name in "${required_packages[@]}"; do
    node -e '
const manifest = require(process.argv[1]);
const packageName = process.argv[2];
if (!manifest.dependencies?.[packageName]) {
  console.error(`Missing mandatory frontend owner dependency: ${packageName}`);
  process.exit(1);
}
' "$FRONTEND_DIR/package.json" "$package_name"
done

fail_if_matches() {
    local description="$1"
    shift
    local matches
    local status
    set +e
    matches="$(rg -n "$@" 2>&1)"
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
        echo "Forbidden frontend ownership pattern: $description" >&2
        echo "$matches" >&2
        return 1
    fi
    if [ "$status" -gt 1 ]; then
        echo "Frontend architecture scan failed: $description" >&2
        echo "$matches" >&2
        return "$status"
    fi
}

fail_if_matches \
    "Recharts must not compete with TanStack Charts" \
    "\"recharts\"|from [\"']recharts|require\\([\"']recharts" \
    "$FRONTEND_DIR/package.json" \
    "$FRONTEND_DIR/package-lock.json" \
    "$FRONTEND_DIR/src"

fail_if_matches \
    "TanStack Router owns browser navigation" \
    '(window\.)?history\.(pushState|replaceState)|location\.hash\s*=' \
    --glob '!**/test/**' \
    --glob '!routeTree.gen.ts' \
    "$FRONTEND_DIR/src"

fail_if_matches \
    "TanStack Hotkeys owns global keyboard shortcut registration" \
    "(document|window)\\.addEventListener\\([\"']key(down|up)" \
    --glob '!**/test/**' \
    "$FRONTEND_DIR/src"
