"""Radio transport coverage gaps (possible firmware queue eviction)."""
import time

_disconnected_at: int | None = None
_last_gap: tuple[int, int] | None = None
_gap_count = 0


def mark_disconnected() -> None:
    global _disconnected_at
    if _disconnected_at is None:
        _disconnected_at = int(time.time())


def mark_connected() -> None:
    global _disconnected_at, _last_gap, _gap_count
    if _disconnected_at is not None:
        _last_gap = (_disconnected_at, int(time.time()))
        _gap_count += 1
    _disconnected_at = None


def snapshot() -> dict:
    return {
        "possible_firmware_queue_loss": _disconnected_at is not None or _gap_count > 0,
        "drop_count": None,  # Companion protocol 13 does not expose per-frame eviction count.
        "coverage_gap_count": _gap_count,
        "disconnected_since": _disconnected_at,
        "last_gap_start": _last_gap[0] if _last_gap else None,
        "last_gap_end": _last_gap[1] if _last_gap else None,
    }
