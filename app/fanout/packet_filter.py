"""MeshCore header payload-type allowlist (independent of route and TX/RX)."""

from __future__ import annotations

from app.path_utils import parse_packet_envelope

PACKET_TYPE_LABELS = {
    0: "req",
    1: "response",
    2: "txt_msg",
    3: "ack",
    4: "advert",
    5: "grp_txt",
    6: "grp_data",
    7: "anon_req",
    8: "path",
    9: "trace",
    10: "multipart",
    11: "control",
    15: "raw_custom",
}


def normalize_packet_filter(value: object) -> str | list[int]:
    if value in ("all", "none"):
        return value  # type: ignore[return-value]
    if not isinstance(value, list) or any(
        isinstance(v, bool) or not isinstance(v, int) or v < 0 or v > 15 for v in value
    ):
        raise ValueError("packet_filter: expected 'all', 'none', or integer payload types 0-15")
    return sorted(set(value))


def admits_packet(filter_value: object, raw: bytes) -> bool:
    allowed = normalize_packet_filter(filter_value)
    if allowed == "none":
        return False
    if allowed == "all":
        return True
    # After the guards above, allowed is list[int].
    envelope = parse_packet_envelope(raw)
    if envelope is None or envelope.payload_version != 0:
        return False
    assert isinstance(allowed, list)  # narrow for pyright
    return envelope.payload_type in allowed
