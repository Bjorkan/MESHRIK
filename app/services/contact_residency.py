"""Generation-fenced, non-destructive Companion residency reconciliation.

SDK 2.3.14 exposes CONTACT_DELETED and CONTACTS_FULL as typed events. An
asynchronous contact removal must never override a *later* positive radio
confirmation (re-add or authoritative contacts snapshot).
"""

from __future__ import annotations

import re
import time

_KEY = re.compile(r"^[0-9a-fA-F]{64}$")
_last_confirmed: dict[str, tuple[int, float]] = {}


def note_confirmed_radio_contact(key: str, generation: int) -> None:
    if _KEY.fullmatch(key):
        _last_confirmed[key.lower()] = (generation, time.monotonic())
        if len(_last_confirmed) > 5000:
            _last_confirmed.clear()  # Bound ephemeral bookkeeping.


def was_confirmed_after(key: str, generation: int, received_at: float) -> bool:
    recorded = _last_confirmed.get(key.lower())
    return recorded is not None and recorded[0] == generation and recorded[1] > received_at
