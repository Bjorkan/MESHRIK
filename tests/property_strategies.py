"""Reusable bounded Hypothesis strategies for protocol and identity invariants."""

from dataclasses import dataclass

from hypothesis import strategies as st

from app.path_utils import MAX_PATH_SIZE

public_keys = st.binary(min_size=32, max_size=32)
message_texts = st.text(
    alphabet=st.characters(blacklist_categories=("Cs",)),
    min_size=0,
    max_size=256,
)


@dataclass(frozen=True)
class PacketExample:
    raw: bytes
    route_type: int
    payload_type: int
    payload_version: int
    hop_count: int
    hash_size: int
    path: bytes
    payload: bytes
    transport_codes: tuple[int, int] | None


@st.composite
def path_shapes(draw):
    """Return a valid `(hop_count, hash_size, path)` wire representation."""
    hash_size = draw(st.integers(min_value=1, max_value=3))
    hop_count = draw(st.integers(min_value=0, max_value=MAX_PATH_SIZE // hash_size))
    path = draw(st.binary(min_size=hop_count * hash_size, max_size=hop_count * hash_size))
    return hop_count, hash_size, path


@st.composite
def packet_examples(draw, *, payload_types=None):
    """Build firmware-shaped packets that always contain at least one payload byte."""
    if payload_types is None:
        payload_types = st.integers(min_value=0, max_value=15)
    route_type = draw(st.integers(min_value=0, max_value=3))
    payload_type = draw(payload_types)
    payload_version = draw(st.integers(min_value=0, max_value=3))
    hop_count, hash_size, path = draw(path_shapes())
    payload = draw(st.binary(min_size=1, max_size=96))
    header = route_type | (payload_type << 2) | (payload_version << 6)
    path_byte = hop_count | ((hash_size - 1) << 6)
    transport_codes = None
    transport_bytes = b""
    if route_type in (0, 3):
        transport_codes = draw(
            st.tuples(
                st.integers(min_value=0, max_value=0xFFFF),
                st.integers(min_value=0, max_value=0xFFFF),
            )
        )
        transport_bytes = b"".join(code.to_bytes(2, "little") for code in transport_codes)
    raw = bytes([header]) + transport_bytes + bytes([path_byte]) + path + payload
    return PacketExample(
        raw=raw,
        route_type=route_type,
        payload_type=payload_type,
        payload_version=payload_version,
        hop_count=hop_count,
        hash_size=hash_size,
        path=path,
        payload=payload,
        transport_codes=transport_codes,
    )
