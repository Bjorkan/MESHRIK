"""Read-only, bounded official suggested radio presets (no automatic radio writes)."""

import asyncio
import math
import time

import httpx

OFFICIAL_CONFIG_URL = "https://api.meshcore.nz/api/v1/config"
MAX_CONFIG_BYTES = 64 * 1024
CACHE_TTL_SECONDS = 6 * 3600
_cache: tuple[float, list[dict]] | None = None
_lock = asyncio.Lock()


def normalize_official_presets(value: object) -> list[dict]:
    if not isinstance(value, dict):
        return []
    config = value.get("config", {})
    suggestions = config.get("suggested_radio_settings", {}) if isinstance(config, dict) else {}
    entries = suggestions.get("entries", []) if isinstance(suggestions, dict) else []
    if not isinstance(entries, list):
        return []
    result: list[dict] = []
    names: set[str] = set()
    for entry in entries[:100]:
        if not isinstance(entry, dict):
            continue
        title = entry.get("title")
        if not isinstance(title, str) or not title.strip() or len(title) > 64:
            continue
        if title in names:
            continue
        try:
            freq = float(entry["frequency"])
            bandwidth = float(entry["bandwidth"])
            sf = int(entry["spreading_factor"])
            cr = int(entry["coding_rate"])
        except (KeyError, ValueError, TypeError, OverflowError):
            continue
        if (
            not all(math.isfinite(x) for x in (freq, bandwidth))
            or not 150 <= freq <= 2500
            or not 7 <= bandwidth <= 500
            or not 5 <= sf <= 12
            or not 5 <= cr <= 8
        ):
            continue
        network = entry.get("network_settings")
        raw_hash_size = network.get("path_hash_size") if isinstance(network, dict) else None
        hash_size = (
            raw_hash_size if type(raw_hash_size) is int and 1 <= raw_hash_size <= 3 else None
        )
        result.append(
            {
                "name": title,
                "freq": freq,
                "bw": bandwidth,
                "sf": sf,
                "cr": cr,
                "path_hash_size": hash_size,
            }
        )
        names.add(title)
    return result


async def get_suggested_presets() -> dict:
    """Cache validated official presets; return no entries on offline failure."""
    global _cache
    async with _lock:
        if _cache and time.monotonic() - _cache[0] < CACHE_TTL_SECONDS:
            return {"source": "official", "stale": False, "presets": _cache[1]}
        try:
            async with httpx.AsyncClient(timeout=3, follow_redirects=False) as client:
                async with client.stream(
                    "GET",
                    OFFICIAL_CONFIG_URL,
                    headers={
                        "User-Agent": "MESHRIK-radio-presets/1.0",
                        "Accept": "application/json",
                    },
                ) as response:
                    response.raise_for_status()
                    if response.status_code != 200:
                        raise ValueError("Unexpected config status")
                    parts: list[bytes] = []
                    total = 0
                    async for fragment in response.aiter_bytes():
                        total += len(fragment)
                        if total > MAX_CONFIG_BYTES:
                            raise ValueError("Official config too large")
                        parts.append(fragment)
                    import json

                    presets = normalize_official_presets(json.loads(b"".join(parts)))
                    if not presets:
                        raise ValueError("No valid radio presets")
                    _cache = (time.monotonic(), presets)
                    return {"source": "official", "stale": False, "presets": presets}
        except (httpx.HTTPError, ValueError, TypeError, UnicodeError):
            return {"source": "offline", "stale": True, "presets": _cache[1] if _cache else []}
