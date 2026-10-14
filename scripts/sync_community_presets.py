"""Regenerate the browser read-only broker preset list from the backend registry."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
(ROOT / 'frontend/src/config/community_presets.json').write_bytes(
    (ROOT / 'app/fanout/community_presets.json').read_bytes()
)
