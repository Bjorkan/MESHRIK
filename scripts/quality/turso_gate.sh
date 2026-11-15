#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
cargo build --locked -p meshrik-turso-probe
probe_target_dir="${CARGO_TARGET_DIR:-target}"
PYTHONPATH=. uv run python scripts/migration/turso_gate.py \
    --probe "$probe_target_dir/debug/meshrik-turso-probe" --check-known
